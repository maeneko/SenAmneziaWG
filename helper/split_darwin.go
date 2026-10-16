//go:build darwin

package main

import (
	"encoding/json"
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

// «Что идёт через VPN» on macOS. awg.sh keeps setting up the tunnel; the service adds, around it:
//
//	exclude  awg.sh's usual 0/1 + 128/1 into the utun stay; every address of a listed name gets a host route
//	         through the physical gateway (re-added when that gateway changes);
//	include  awg.sh adds no default route (--split include); every address of a listed name gets a host
//	         route into the utun.
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

// gateways follows the physical default route: where host routes of exclude mode point, and which
// interface the proxy's direct questions are bound to. Polled, as awg.sh's monitor re-pins the endpoint.
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
	mode string
	gws  *gateways

	mu    sync.Mutex
	iface string // the utun, known once awg.sh has run (include mode)
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

func (r *darwinRouter) Divert(ip netip.Addr) error {
	fam := routeFamily(ip)
	// Whatever is there is replaced: a stale route of ours (an old gateway) must not make `add` fail.
	_, _ = runCmd(routeBin, "-q", "-n", "delete", fam, "-host", ip.String())
	var out string
	var err error
	if r.mode == proto.SplitInclude {
		r.mu.Lock()
		iface := r.iface
		r.mu.Unlock()
		if iface == "" {
			return fmt.Errorf("туннель ещё не поднят")
		}
		out, err = runCmd(routeBin, "-q", "-n", "add", fam, "-host", ip.String(), "-interface", iface)
	} else {
		gw := r.gws.gateway(ip)
		if gw == "" {
			return fmt.Errorf("нет основного шлюза")
		}
		out, err = runCmd(routeBin, "-q", "-n", "add", fam, "-host", ip.String(), gw)
	}
	if err != nil {
		return fmt.Errorf("route add %s: %v: %s", ip, err, out)
	}
	r.store.note(ip, true)
	return nil
}

func (r *darwinRouter) Release(ip netip.Addr) error {
	_, err := runCmd(routeBin, "-q", "-n", "delete", routeFamily(ip), "-host", ip.String())
	r.store.note(ip, false)
	return err
}

// splitRun is the running proxy and what it needs undone.
type splitRun struct {
	mode      string
	proxy     *splitdns.Proxy
	router    *darwinRouter
	routes    *splitdns.RouteSet
	gws       *gateways
	store     *splitStore
	dnsRoutes []netip.Addr
	// exclude mode: the system's own DNS servers, kept off the tunnel by a host route of their own.
	directPins []netip.Addr
	aliased    bool
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
	run := &splitRun{mode: st.Mode, aliased: aliased}
	fail := func(err error) (*splitRun, error) {
		run.stop()
		return nil, err
	}

	gws := &gateways{}
	gws.refresh()
	run.gws = gws
	run.store = newSplitStore(splitStatePath(), st)
	run.router = &darwinRouter{mode: st.Mode, gws: gws, store: run.store}
	skip := map[netip.Addr]bool{}
	if ip, err := netip.ParseAddr(st.Endpoint); err == nil {
		skip[ip.Unmap()] = true
	}
	tunnelNS := splitdns.ParseAddrs(st.TunnelNS)
	for _, ip := range tunnelNS {
		skip[ip] = true
	}
	run.routes = splitdns.NewRouteSet(run.router, func(ip netip.Addr) bool { return skip[ip] })
	run.dnsRoutes = tunnelNS

	// The proxy asks the system's DNS from an ordinary socket, so the route decides where it goes. A socket
	// bound to the physical interface (IP_BOUND_IF) cannot be used: with the tunnel's 0/1 in place the
	// interface has no scoped default route, and everything off the local network is «unreachable».
	var plain net.Dialer
	proxy, err := buildProxy(st, run.routes, plain.DialContext, func(f string, a ...any) { svcInfo("раздельный режим: "+f, a...) })
	if err != nil {
		return fail(err)
	}
	run.proxy = proxy
	if st.Mode == proto.SplitExclude {
		for _, ip := range splitdns.ParseAddrs(st.DirectNS) {
			// The same address as the tunnel's DNS (Cloudflare on both sides is common): a route around the
			// tunnel for it would take the tunnel's own questions around the tunnel too.
			if onLink(ip) || skip[ip] {
				continue
			}
			if err := run.router.Divert(ip); err != nil {
				svcWarn("раздельный режим: маршрут до DNS системы %s: %v", ip, err)
				continue
			}
			run.directPins = append(run.directPins, ip)
		}
	}

	// When the physical gateway changes, the routes that point at the old one are laid again.
	gws.change = func() {
		if run.mode != proto.SplitExclude {
			return
		}
		for _, ip := range append(run.routes.Addrs(), run.directPins...) {
			if err := run.router.Divert(ip); err != nil {
				svcWarn("раздельный режим: маршрут для %s после смены сети: %v", ip, err)
			}
		}
	}
	gws.watch()
	svcInfo("раздельный режим: %s, сайтов в списке %d, DNS туннеля %v, DNS системы %v", st.Mode, len(st.Domains), st.TunnelNS, st.DirectNS)
	return run, nil
}

// attach tells the proxy which utun the tunnel got; include mode routes the tunnel's DNS into it.
func (s *splitRun) attach(iface string) error {
	s.router.setIface(iface)
	s.store.update(func(st *splitState) { st.Iface = iface })
	if s.mode == proto.SplitInclude {
		for _, ip := range s.dnsRoutes {
			if err := s.router.Divert(ip); err != nil {
				return fmt.Errorf("маршрут до DNS туннеля %s: %w", ip, err)
			}
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
	for _, ip := range append(append([]netip.Addr(nil), s.dnsRoutes...), s.directPins...) {
		_ = s.router.Release(ip)
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
	b, err := os.ReadFile(splitStatePath())
	if err != nil {
		return
	}
	var st splitState
	if json.Unmarshal(b, &st) == nil {
		for _, r := range st.Routes {
			if ip, err := netip.ParseAddr(r); err == nil {
				_, _ = runCmd(routeBin, "-q", "-n", "delete", routeFamily(ip), "-host", ip.String())
			}
		}
	}
	removeLoopbackAlias()
	_ = os.Remove(splitStatePath())
}

// reconcileSplit runs when the service starts. A tunnel that is still up with a saved split lost its
// proxy with the old service: start it again, with the same list and the routes it had. Otherwise
// whatever the saved state names is removed.
func (c *controller) reconcileSplit() {
	c.mu.Lock()
	defer c.mu.Unlock()
	b, err := os.ReadFile(splitStatePath())
	if err != nil {
		return
	}
	var st splitState
	st2, _ := readState()
	active := false
	if st2["IFACE"] != "" {
		_, uerr := uapiRequest(st2["IFACE"], "get=1\n\n", statusTimeout)
		active = uerr == nil
	}
	if json.Unmarshal(b, &st) != nil || !active || st.Mode == "" {
		svcWarn("раздельный режим: после прошлого запуска остались маршруты — убираю")
		cleanupSplitLeftovers()
		return
	}
	svcWarn("раздельный режим: служба перезапущена при работающем туннеле — поднимаю DNS-прокси заново")
	_ = os.Remove(splitStatePath())
	run, err := startSplitProxy(st)
	if err != nil {
		svcError("раздельный режим: %v", err)
		return
	}
	if err := run.attach(st2["IFACE"]); err != nil {
		svcWarn("раздельный режим: %v", err)
	}
	for _, r := range st.Routes {
		if ip, err := netip.ParseAddr(r); err == nil {
			_, _ = run.routes.Ensure(ip)
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
