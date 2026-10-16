//go:build darwin

package main

import (
	"fmt"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"senawg-helper/internal/proto"
	"senawg-helper/internal/splitdns"
)

// «Маршрутизация» on macOS. awg.sh keeps setting up the tunnel; the service adds, around it:
//
//	default proxy   awg.sh's usual 0/1 + 128/1 into the utun stay; every address of a name (or network) a rule
//	                sends direct gets a route through the physical gateway (re-laid when that gateway changes);
//	default direct  awg.sh adds no default route (--split include); every address a rule sends through the tunnel
//	                gets a route into the utun;
//	block           a black-hole route for an `ip:` rule; a name under a block rule gets NXDOMAIN and no route.
//
// The names are seen by a DNS proxy on 127.77.0.1 (an alias of lo0), which awg.sh points the system's DNS at.
// The proxy lives in the service, which lives as long as the app does — as the tunnel does. If the service
// is killed meanwhile, split.json lets the next one pick the proxy up again (reconcileSplit).

const (
	routeBin    = "/sbin/route"
	ifconfigBin = "/sbin/ifconfig"
	netstatBin  = "/usr/sbin/netstat"
	scutilBin   = "/usr/sbin/scutil"
)

func splitStatePath() string { return filepath.Join(stateDir, "split.json") }

func runCmd(bin string, args ...string) (string, error) {
	out, err := exec.Command(bin, args...).CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

// gateways follows the physical default route: where the routes of «direct» point. Polled, as awg.sh's monitor
// re-pins the endpoint.
type gateways struct {
	mu     sync.Mutex
	gw     [2]string // [0] inet, [1] inet6
	iface  [2]string
	change func()
	stop   chan struct{}
}

func familyIndex(ip netip.Addr) int {
	if ip.Is6() {
		return 1
	}
	return 0
}

func (g *gateways) refresh() bool {
	changed := false
	for i, fam := range []string{"inet", "inet6"} {
		out, _ := runCmd(netstatBin, "-nr", "-f", fam)
		gw, iface := parseNetstatDefault(out)
		g.mu.Lock()
		if g.gw[i] != gw || g.iface[i] != iface {
			g.gw[i], g.iface[i], changed = gw, iface, true
		}
		g.mu.Unlock()
	}
	return changed
}

func (g *gateways) gateway(ip netip.Addr) string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.gw[familyIndex(ip)]
}

func (g *gateways) watch() {
	g.stop = make(chan struct{})
	go func() {
		t := time.NewTicker(3 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-g.stop:
				return
			case <-t.C:
				if g.refresh() && g.change != nil {
					g.change()
				}
			}
		}
	}()
}

// onLink: ip is in a network one of the physical interfaces is directly attached to. Such an address is
// reached through that interface's own connected route, which is longer than the tunnel's 0/1.
func onLink(ip netip.Addr) bool {
	ifaces, err := net.Interfaces()
	if err != nil {
		return false
	}
	for _, ifc := range ifaces {
		if strings.HasPrefix(ifc.Name, "utun") || strings.HasPrefix(ifc.Name, "lo") {
			continue
		}
		addrs, _ := ifc.Addrs()
		for _, a := range addrs {
			if ipn, ok := a.(*net.IPNet); ok && ipn.Contains(net.IP(ip.AsSlice())) {
				return true
			}
		}
	}
	return false
}

// darwinRouter implements splitdns.Router with route(8).
type darwinRouter struct {
	gws *gateways

	mu    sync.Mutex
	iface string // the utun, known once awg.sh has run
	store *splitStore
}

func (r *darwinRouter) setIface(name string) {
	r.mu.Lock()
	r.iface = name
	r.mu.Unlock()
}

func routeFamily(ip netip.Addr) string {
	if ip.Is6() {
		return "-inet6"
	}
	return "-inet"
}

// routeTarget is how route(8) names the destination: a host, or a network.
func routeTarget(p netip.Prefix) []string {
	if p.IsSingleIP() {
		return []string{"-host", p.Addr().String()}
	}
	return []string{"-net", p.String()}
}

func (r *darwinRouter) Route(p netip.Prefix, way splitdns.Way) error {
	fam := routeFamily(p.Addr())
	target := routeTarget(p)
	// Whatever is there is replaced: a stale route of ours (an old gateway) must not make `add` fail.
	_, _ = runCmd(routeBin, append([]string{"-q", "-n", "delete", fam}, target...)...)
	args := append([]string{"-q", "-n", "add", fam}, target...)
	switch way {
	case splitdns.WayTunnel:
		r.mu.Lock()
		iface := r.iface
		r.mu.Unlock()
		if iface == "" {
			return fmt.Errorf("туннель ещё не поднят")
		}
		args = append(args, "-interface", iface)
	case splitdns.WayDirect:
		gw := r.gws.gateway(p.Addr())
		if gw == "" {
			return fmt.Errorf("нет основного шлюза")
		}
		args = append(args, gw)
	default:
		sink := "127.0.0.1"
		if p.Addr().Is6() {
			sink = "::1"
		}
		args = append(args, sink, "-blackhole")
	}
	if out, err := runCmd(routeBin, args...); err != nil {
		return fmt.Errorf("route add %s: %v: %s", p, err, out)
	}
	r.store.note(p, way, true)
	return nil
}

func (r *darwinRouter) Unroute(p netip.Prefix, way splitdns.Way) error {
	_, err := runCmd(routeBin, append([]string{"-q", "-n", "delete", routeFamily(p.Addr())}, routeTarget(p)...)...)
	r.store.note(p, way, false)
	return err
}

// splitRun is the running proxy and what it needs undone.
type splitRun struct {
	final   string
	proxy   *splitdns.Proxy
	router  *darwinRouter
	routes  *splitdns.RouteSet
	gws     *gateways
	store   *splitStore
	static  []splitdns.Entry // the `ip:` rules
	tunNS   []netip.Addr
	aliased bool
}

// addLoopbackAlias gives lo0 the proxy's address; macOS has only 127.0.0.1 there by default.
func addLoopbackAlias() (bool, error) {
	if ifc, err := net.InterfaceByName("lo0"); err == nil {
		if addrs, err := ifc.Addrs(); err == nil {
			for _, a := range addrs {
				if ipn, ok := a.(*net.IPNet); ok && ipn.IP.String() == splitListenAddr {
					return false, nil
				}
			}
		}
	}
	if out, err := runCmd(ifconfigBin, "lo0", "alias", splitListenAddr, "255.255.255.255"); err != nil {
		return false, fmt.Errorf("ifconfig lo0 alias: %v: %s", err, out)
	}
	return true, nil
}

func removeLoopbackAlias() { _, _ = runCmd(ifconfigBin, "lo0", "-alias", splitListenAddr) }

func systemResolvers() []netip.Addr {
	out, err := runCmd(scutilBin, "--dns")
	if err != nil {
		return nil
	}
	return parseScutilDNS(out)
}

// startSplitProxy starts the proxy from a saved or fresh configuration. The tunnel need not be up yet:
// the system's DNS is pointed at the proxy only when awg.sh runs, and the utun is known after that.
func startSplitProxy(st splitState) (*splitRun, error) {
	aliased, err := addLoopbackAlias()
	if err != nil {
		return nil, err
	}
	run := &splitRun{final: st.Final, aliased: aliased}
	fail := func(err error) (*splitRun, error) {
		run.stop()
		return nil, err
	}

	gws := &gateways{}
	gws.refresh()
	run.gws = gws
	run.store = newSplitStore(splitStatePath(), st)
	run.router = &darwinRouter{gws: gws, store: run.store}
	skip := map[netip.Addr]bool{}
	if ip, err := netip.ParseAddr(st.Endpoint); err == nil {
		skip[ip.Unmap()] = true
	}
	run.tunNS = splitdns.ParseAddrs(st.TunnelNS)
	for _, ip := range run.tunNS {
		skip[ip] = true
	}
	run.routes = splitdns.NewRouteSet(run.router, func(ip netip.Addr) bool { return skip[ip] })
	run.static = staticRoutes(st)

	// The proxy asks the system's DNS from an ordinary socket, so the route decides where it goes. A socket
	// bound to the physical interface (IP_BOUND_IF) cannot be used: with the tunnel's 0/1 in place the
	// interface has no scoped default route, and everything off the local network is «unreachable».
	var plain net.Dialer
	proxy, err := buildProxy(st, run.routes, plain.DialContext, func(f string, a ...any) { svcInfo("маршрутизация: "+f, a...) })
	if err != nil {
		return fail(err)
	}
	run.proxy = proxy
	if st.Final == proto.FinalProxy {
		// Everything goes into the tunnel by default, which would take the system's own DNS in too; its servers
		// keep a way of their own. A server that is also the tunnel's DNS stays in the tunnel: a route around
		// it would take the tunnel's own questions around the tunnel as well.
		for _, ip := range splitdns.ParseAddrs(st.DirectNS) {
			if onLink(ip) || skip[ip] {
				continue
			}
			if err := run.routes.Pin(splitdns.HostPrefix(ip), splitdns.WayDirect); err != nil {
				svcWarn("маршрутизация: маршрут до DNS системы %s: %v", ip, err)
			}
		}
	}

	// When the physical gateway changes, the routes that point at the old one are laid again.
	gws.change = func() {
		for _, e := range run.routes.Entries() {
			if e.Way != splitdns.WayDirect {
				continue
			}
			if err := run.router.Route(e.Prefix, e.Way); err != nil {
				svcWarn("маршрутизация: маршрут для %s после смены сети: %v", e.Prefix, err)
			}
		}
	}
	gws.watch()
	svcInfo("маршрутизация: по умолчанию %s, правил %d, DNS туннеля %v, DNS системы %v", wordOf(st.Final), len(st.Rules), st.TunnelNS, st.DirectNS)
	return run, nil
}

func wordOf(final string) string {
	if final == proto.FinalDirect {
		return "напрямую"
	}
	return "через туннель"
}

// attach tells the proxy which utun the tunnel got, and lays what needs it: the tunnel's DNS when the default
// is direct, and the networks the `ip:` rules name.
func (s *splitRun) attach(iface string) error {
	s.router.setIface(iface)
	s.store.update(func(st *splitState) { st.Iface = iface })
	if s.final == proto.FinalDirect {
		for _, ip := range s.tunNS {
			if err := s.routes.Pin(splitdns.HostPrefix(ip), splitdns.WayTunnel); err != nil {
				return fmt.Errorf("маршрут до DNS туннеля %s: %w", ip, err)
			}
		}
	}
	for _, e := range s.static {
		if err := s.routes.Pin(e.Prefix, e.Way); err != nil {
			svcWarn("маршрутизация: правило ip:%s: %v", e.Prefix, err)
		}
	}
	return nil
}

// stop undoes everything: proxy, routes, alias, saved state.
func (s *splitRun) stop() {
	if s == nil {
		return
	}
	if s.gws != nil && s.gws.stop != nil {
		close(s.gws.stop)
	}
	if s.proxy != nil {
		s.proxy.Close() // takes its routes with it
	}
	if s.store != nil {
		s.store.close()
	}
	if s.aliased {
		removeLoopbackAlias()
	}
	_ = os.Remove(splitStatePath())
}

// beginSplit prepares a fresh run from a request: reads the system's DNS first, while it is still the
// system's, then starts the proxy.
func beginSplit(req *proto.Request) (*splitRun, error) {
	return startSplitProxy(splitStateFrom(req, endpointOf(req.Conf), systemResolvers(), hasV6(req.Address)))
}

// cleanupSplitLeftovers removes what a service that was killed left: the routes in split.json, the alias.
func cleanupSplitLeftovers() {
	if st, ok := looseSplitState(splitStatePath()); ok {
		for _, r := range st.Routes {
			if p, ok := parseRouteKey(r.P); ok {
				_, _ = runCmd(routeBin, append([]string{"-q", "-n", "delete", routeFamily(p.Addr())}, routeTarget(p)...)...)
			}
		}
	}
	removeLoopbackAlias()
	_ = os.Remove(splitStatePath())
}

// reconcileSplit runs when the service starts. A tunnel that is still up with a saved routing lost its proxy
// with the old service: start it again, with the same rules and the routes it had. Otherwise whatever the
// saved state names is removed.
func (c *controller) reconcileSplit() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, err := os.Stat(splitStatePath()); err != nil {
		return
	}
	st, valid := readSplitState(splitStatePath())
	st2, _ := readState()
	active := false
	if st2["IFACE"] != "" {
		_, uerr := uapiRequest(st2["IFACE"], "get=1\n\n", statusTimeout)
		active = uerr == nil
	}
	if !valid || !active {
		svcWarn("маршрутизация: после прошлого запуска остались маршруты — убираю")
		cleanupSplitLeftovers()
		return
	}
	svcWarn("маршрутизация: служба перезапущена при работающем туннеле — поднимаю DNS-прокси заново")
	saved := st.Routes
	_ = os.Remove(splitStatePath())
	st.Routes = nil
	run, err := startSplitProxy(st)
	if err != nil {
		svcError("маршрутизация: %v", err)
		return
	}
	if err := run.attach(st2["IFACE"]); err != nil {
		svcWarn("маршрутизация: %v", err)
	}
	// The routes of names are still in the table; they are tracked again, and expire as they would have.
	for _, r := range saved {
		if p, ok := parseRouteKey(r.P); ok && p.IsSingleIP() && r.W != 0 {
			run.routes.Adopt(p.Addr(), splitdns.Way(r.W))
			run.store.note(p, splitdns.Way(r.W), true)
		}
	}
	c.split = run
}

// stopSplit ends the current run, if any. The caller holds c.mu.
func (c *controller) stopSplitLocked() {
	c.split.stop()
	c.split = nil
}

// shutdownSplit is runService's last step.
func (c *controller) shutdownSplit() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.stopSplitLocked()
}
