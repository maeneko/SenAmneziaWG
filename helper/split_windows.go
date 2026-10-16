//go:build windows

package main

import (
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"sync"
	"syscall"
	"time"

	"github.com/amnezia-vpn/amneziawg-windows/v3/tunnel/winipcfg"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"

	"senawg-helper/internal/proto"
	"senawg-helper/internal/splitdns"
)

// «Маршрутизация» on Windows. The peer keeps AllowedIPs = 0/0, but the tunnel service is started with
// `Table = off` (splitConf): the fork then installs no routes and no firewall rules of its own, so the
// kill switch (which needs a literal default route) is off in a split. The service does the routing:
//
//	default proxy   0/1 + 128/1 (and ::/1 + 8000::/1) into the tunnel, as the fork's /0 would be, plus a route
//	                through the physical gateway for every address a rule sends direct;
//	default direct  no default route; a route into the tunnel for every address a rule sends through it.
//
// A black-hole route has no equivalent here (an `ip:` rule that blocks is refused with a warning); a name under a
// block rule gets NXDOMAIN, which needs no route.
//
// The names are seen by a DNS proxy on 127.77.0.1: it is the tunnel adapter's DNS (the .conf) and the
// target of a catch-all rule of the DNS Client (NRPT), because Windows otherwise asks every adapter's DNS
// at once and an answer from the router's DNS would never pass the proxy.
const (
	ipUnicastIf = 31 // IP_UNICAST_IF and IPV6_UNICAST_IF
	// A fixed rule id, so a rule left by a crash is the one removed next time.
	nrptKey = `SOFTWARE\Policies\Microsoft\Windows NT\DNSClient\DnsPolicyConfig\{53454E41-5747-4000-8000-0000534E5250}`
	ifLoop  = 24
)

func (d dirs) splitPath() string { return filepath.Join(d.data, "split.json") }

func prefixNet(p netip.Prefix) net.IPNet {
	return net.IPNet{IP: p.Addr().AsSlice(), Mask: net.CIDRMask(p.Bits(), p.Addr().BitLen())}
}

func family(ip netip.Addr) winipcfg.AddressFamily {
	if ip.Is6() {
		return windows.AF_INET6
	}
	return windows.AF_INET
}

func zeroHop(ip netip.Addr) net.IP {
	if ip.Is6() {
		return net.IPv6zero
	}
	return net.IPv4zero
}

// physical is the default route a packet would take if the tunnel were not there.
type physical struct {
	luid    winipcfg.LUID
	index   uint32
	nextHop net.IP
}

// network follows the physical default routes: where the exclude host routes point and which interface
// the proxy's direct questions are bound to. Polled, like macOS's gateways.
type network struct {
	mu     sync.Mutex
	ours   winipcfg.LUID // the tunnel adapter, once it exists
	best   [2]physical   // [0] IPv4, [1] IPv6
	change func()
	stop   chan struct{}
}

func (n *network) setOurs(l winipcfg.LUID) {
	n.mu.Lock()
	n.ours = l
	n.mu.Unlock()
}

func (n *network) refresh() bool {
	changed := false
	adapters, _ := winipcfg.GetAdaptersAddresses(windows.AF_UNSPEC, winipcfg.GAAFlagDefault)
	metric := map[winipcfg.LUID][2]uint32{}
	for _, a := range adapters {
		metric[a.LUID] = [2]uint32{a.Ipv4Metric, a.Ipv6Metric}
	}
	n.mu.Lock()
	ours := n.ours
	n.mu.Unlock()
	if ours == 0 {
		ours = tunnelLUID() // a tunnel adapter that exists but is not attached yet is no candidate either
	}
	for i, fam := range []winipcfg.AddressFamily{windows.AF_INET, windows.AF_INET6} {
		var best physical
		bestMetric := uint64(1) << 40
		rows, _ := winipcfg.GetIPForwardTable2(fam)
		for _, r := range rows {
			if r.DestinationPrefix.PrefixLength != 0 || r.InterfaceLUID == ours {
				continue
			}
			m := uint64(r.Metric) + uint64(metric[r.InterfaceLUID][i])
			if m < bestMetric {
				bestMetric = m
				best = physical{luid: r.InterfaceLUID, index: r.InterfaceIndex, nextHop: r.NextHop.IP()}
			}
		}
		n.mu.Lock()
		if n.best[i].luid != best.luid || !n.best[i].nextHop.Equal(best.nextHop) {
			n.best[i], changed = best, true
		}
		n.mu.Unlock()
	}
	return changed
}

// tunnelLUID is the adapter the tunnel service made, by its name; 0 while there is none.
func tunnelLUID() winipcfg.LUID {
	adapters, err := winipcfg.GetAdaptersAddresses(windows.AF_UNSPEC, winipcfg.GAAFlagDefault)
	if err != nil {
		return 0
	}
	for _, a := range adapters {
		if a.FriendlyName() == tunnelName {
			return a.LUID
		}
	}
	return 0
}

func (n *network) gateway(ip netip.Addr) physical {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.best[familyIndex(ip)]
}

func familyIndex(ip netip.Addr) int {
	if ip.Is6() {
		return 1
	}
	return 0
}

func (n *network) ifIndex(v6 bool) uint32 {
	i := 0
	if v6 {
		i = 1
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.best[i].index
}

func (n *network) watch() {
	n.stop = make(chan struct{})
	go func() {
		t := time.NewTicker(3 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-n.stop:
				return
			case <-t.C:
				if n.refresh() && n.change != nil {
					n.change()
				}
			}
		}
	}()
}

func htonl(v uint32) uint32 { return v<<24 | (v&0xff00)<<8 | (v>>8)&0xff00 | v>>24 }

// directDialer opens sockets pinned to the physical interface (IP_UNICAST_IF), so a question for the
// system's own DNS leaves by the real network while the tunnel's routes cover everything else.
func (n *network) directDialer() splitdns.Dialer {
	d := net.Dialer{Control: func(netw, _ string, c syscall.RawConn) error {
		v6 := len(netw) > 0 && netw[len(netw)-1] == '6'
		idx := n.ifIndex(v6)
		if idx == 0 {
			return errors.New("нет подключения к сети")
		}
		var serr error
		if err := c.Control(func(fd uintptr) {
			if v6 {
				serr = windows.SetsockoptInt(windows.Handle(fd), windows.IPPROTO_IPV6, ipUnicastIf, int(idx))
			} else {
				serr = windows.SetsockoptInt(windows.Handle(fd), windows.IPPROTO_IP, ipUnicastIf, int(htonl(idx)))
			}
		}); err != nil {
			return err
		}
		return serr
	}}
	return d.DialContext
}

func isExists(err error) bool   { return errors.Is(err, windows.ERROR_OBJECT_ALREADY_EXISTS) }
func isNotFound(err error) bool { return errors.Is(err, windows.ERROR_NOT_FOUND) }

// winRouter implements splitdns.Router.
type winRouter struct {
	net   *network
	store *splitStore

	mu     sync.Mutex
	tun    winipcfg.LUID
	placed map[netip.Prefix]physical // «direct»: where each route was put, to delete exactly that
}

func (r *winRouter) setTunnel(l winipcfg.LUID) {
	r.mu.Lock()
	r.tun = l
	r.mu.Unlock()
}

func (r *winRouter) Route(p netip.Prefix, way splitdns.Way) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	dst := prefixNet(p)
	switch way {
	case splitdns.WayTunnel:
		if r.tun == 0 {
			return errors.New("туннель ещё не поднят")
		}
		if err := r.tun.AddRoute(dst, zeroHop(p.Addr()), 0); err != nil && !isExists(err) {
			return err
		}
	case splitdns.WayDirect:
		gw := r.net.gateway(p.Addr())
		if gw.luid == 0 {
			return errors.New("нет основного шлюза")
		}
		if old, ok := r.placed[p]; ok {
			if old.luid == gw.luid && old.nextHop.Equal(gw.nextHop) {
				return nil
			}
			_ = old.luid.DeleteRoute(dst, old.nextHop)
		}
		if err := gw.luid.AddRoute(dst, gw.nextHop, 0); err != nil && !isExists(err) {
			return err
		}
		r.placed[p] = gw
	default:
		return errors.New("блок по IP в Windows не поддерживается (блок по доменным именам работает)")
	}
	r.store.note(p, way, true)
	return nil
}

func (r *winRouter) Unroute(p netip.Prefix, way splitdns.Way) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	dst := prefixNet(p)
	r.store.note(p, way, false)
	var err error
	switch way {
	case splitdns.WayTunnel:
		if r.tun != 0 {
			err = r.tun.DeleteRoute(dst, zeroHop(p.Addr()))
		}
	case splitdns.WayDirect:
		if old, ok := r.placed[p]; ok {
			err = old.luid.DeleteRoute(dst, old.nextHop)
			delete(r.placed, p)
		}
	}
	if isNotFound(err) {
		return nil
	}
	return err
}

// addNRPT sends every name to the proxy: a rule of the DNS Client for the whole namespace.
func addNRPT() error {
	k, _, err := registry.CreateKey(registry.LOCAL_MACHINE, nrptKey, registry.ALL_ACCESS)
	if err != nil {
		return err
	}
	defer k.Close()
	if err := k.SetStringsValue("Name", []string{"."}); err != nil {
		return err
	}
	if err := k.SetStringValue("GenericDNSServers", splitListenAddr); err != nil {
		return err
	}
	if err := k.SetDWordValue("ConfigOptions", 8); err != nil {
		return err
	}
	return k.SetDWordValue("Version", 2)
}

func removeNRPT() { _ = registry.DeleteKey(registry.LOCAL_MACHINE, nrptKey) }

// flushDNS empties the DNS Client's cache and has it re-read its rules.
func flushDNS() {
	cmd := exec.Command("ipconfig", "/flushdns")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	_ = cmd.Run()
}

// systemResolvers are the DNS servers of the adapters that are up, the best interface first. Read before
// the tunnel and the NRPT rule exist, so none of them is ours.
func systemResolvers() []netip.Addr {
	adapters, err := winipcfg.GetAdaptersAddresses(windows.AF_UNSPEC, winipcfg.GAAFlagDefault)
	if err != nil {
		return nil
	}
	sort.SliceStable(adapters, func(i, j int) bool { return adapters[i].Ipv4Metric < adapters[j].Ipv4Metric })
	var out []netip.Addr
	seen := map[netip.Addr]bool{}
	for _, a := range adapters {
		if a.OperStatus != winipcfg.IfOperStatusUp || a.IfType == ifLoop || a.FriendlyName() == tunnelName {
			continue
		}
		for s := a.FirstDNSServerAddress; s != nil; s = s.Next {
			ip, ok := netip.AddrFromSlice(s.Address.IP())
			if !ok {
				continue
			}
			ip = ip.Unmap()
			// fec0:0:0:ffff::1 and friends are placeholders Windows lists for IPv6 when none is set.
			if ip.IsLoopback() || ip.IsUnspecified() || ip.IsLinkLocalUnicast() || ip.IsMulticast() || (ip.Is6() && ip.As16()[0] == 0xfe && ip.As16()[1] == 0xc0) || seen[ip] {
				continue
			}
			seen[ip] = true
			out = append(out, ip)
		}
	}
	return out
}

// splitRun is the running proxy and what it needs undone.
type splitRun struct {
	final  string
	proxy  *splitdns.Proxy
	router *winRouter
	routes *splitdns.RouteSet
	net    *network
	store  *splitStore
	static []splitdns.Entry // the `ip:` rules
	tunNS  []netip.Addr
	nrpt   bool
}

// startSplitProxy starts the proxy from a saved or fresh configuration. The tunnel need not be up yet.
func (c *controller) startSplitProxy(st splitState) (*splitRun, error) {
	run := &splitRun{final: st.Final}
	fail := func(err error) (*splitRun, error) {
		run.stop(c.d.splitPath())
		return nil, err
	}
	n := &network{}
	n.refresh()
	run.net = n
	run.store = newSplitStore(c.d.splitPath(), st)
	run.router = &winRouter{net: n, store: run.store, placed: map[netip.Prefix]physical{}}
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

	proxy, err := buildProxy(st, run.routes, n.directDialer(), func(f string, a ...any) { c.mirror.Note(fmt.Sprintf("маршрутизация: "+f, a...)) })
	if err != nil {
		return fail(err)
	}
	run.proxy = proxy
	n.change = func() {
		for _, e := range run.routes.Entries() {
			if e.Way != splitdns.WayDirect {
				continue
			}
			if err := run.router.Route(e.Prefix, e.Way); err != nil {
				c.mirror.Note(fmt.Sprintf("маршрутизация: маршрут для %s после смены сети: %v", e.Prefix, err))
			}
		}
	}
	n.watch()
	c.mirror.Note(fmt.Sprintf("маршрутизация: по умолчанию %s, правил %d, DNS туннеля %v, DNS системы %v", wordOf(st.Final), len(st.Rules), st.TunnelNS, st.DirectNS))
	return run, nil
}

func wordOf(final string) string {
	if final == proto.FinalDirect {
		return "напрямую"
	}
	return "через туннель"
}

// attach is called once the tunnel service is running: it finds the adapter, lays the routes the fork did
// not (Table = off) and points the DNS Client at the proxy.
func (c *controller) attach(run *splitRun, allowed []string, v4, v6 bool) error {
	var luid winipcfg.LUID
	for i := 0; i < 50 && luid == 0; i++ {
		if luid = tunnelLUID(); luid == 0 {
			time.Sleep(100 * time.Millisecond)
		}
	}
	if luid == 0 {
		return errors.New("адаптер туннеля не найден")
	}
	run.net.setOurs(luid)
	run.net.refresh() // now without the tunnel among the candidates
	run.router.setTunnel(luid)

	for _, cidr := range allowed {
		p, err := netip.ParsePrefix(cidr)
		if err != nil {
			continue
		}
		a := p.Addr()
		if (a.Is4() && !v4) || (a.Is6() && !v6) {
			continue
		}
		var halves []net.IPNet
		if p.Bits() == 0 {
			if run.final == proto.FinalDirect {
				continue // nothing flows into the tunnel unless a rule sent it there
			}
			halves = defaultHalves(a.Is6())
		} else {
			_, ipn, err := net.ParseCIDR(cidr)
			if err != nil {
				continue
			}
			halves = []net.IPNet{*ipn}
		}
		for _, h := range halves {
			if err := luid.AddRoute(h, zeroHop(a), 0); err != nil && !isExists(err) {
				return fmt.Errorf("маршрут %s: %w", h.String(), err)
			}
		}
	}
	if run.final == proto.FinalDirect {
		for _, ip := range run.tunNS {
			if err := run.routes.Pin(splitdns.HostPrefix(ip), splitdns.WayTunnel); err != nil {
				return fmt.Errorf("маршрут до DNS туннеля %s: %w", ip, err)
			}
		}
	}
	for _, e := range run.static {
		if err := run.routes.Pin(e.Prefix, e.Way); err != nil {
			c.mirror.Note(fmt.Sprintf("маршрутизация: правило ip:%s: %v", e.Prefix, err))
		}
	}
	if err := addNRPT(); err != nil {
		// The tunnel adapter's own DNS is already the proxy; only names that adapters of the router answer
		// first can slip past it.
		c.mirror.Note("маршрутизация: правило DNS-клиента не записано (" + err.Error() + ") — часть запросов может идти мимо")
	} else {
		run.nrpt = true
		run.store.update(func(st *splitState) { st.NRPT = true })
	}
	flushDNS()
	return nil
}

// defaultHalves are what stands in for a default route: two routes, each longer than any real default.
func defaultHalves(v6 bool) []net.IPNet {
	if v6 {
		_, a, _ := net.ParseCIDR("::/1")
		_, b, _ := net.ParseCIDR("8000::/1")
		return []net.IPNet{*a, *b}
	}
	_, a, _ := net.ParseCIDR("0.0.0.0/1")
	_, b, _ := net.ParseCIDR("128.0.0.0/1")
	return []net.IPNet{*a, *b}
}

// stop undoes everything: the DNS rule, the proxy, the routes, the saved state.
func (s *splitRun) stop(path string) {
	if s == nil {
		return
	}
	if s.nrpt {
		removeNRPT()
	}
	if s.net != nil && s.net.stop != nil {
		close(s.net.stop)
	}
	if s.proxy != nil {
		s.proxy.Close() // takes its routes with it
	}
	if s.store != nil {
		s.store.close()
	}
	_ = os.Remove(path)
	flushDNS()
}

// cleanupSplitLeftovers removes what a service that died left: the routes and the DNS rule.
func (c *controller) cleanupSplitLeftovers() {
	removeNRPT()
	if st, ok := looseSplitState(c.d.splitPath()); ok {
		for _, r := range st.Routes {
			p, ok := parseRouteKey(r.P)
			if !ok {
				continue
			}
			// Where a route sat is not saved; look for it in the table by its destination.
			dst := prefixNet(p)
			rows, _ := winipcfg.GetIPForwardTable2(family(p.Addr()))
			for _, row := range rows {
				if int(row.DestinationPrefix.PrefixLength) == p.Bits() && row.DestinationPrefix.IPNet().IP.Equal(dst.IP) {
					_ = row.InterfaceLUID.DeleteRoute(dst, row.NextHop.IP())
				}
			}
		}
	}
	_ = os.Remove(c.d.splitPath())
	flushDNS()
}

func (c *controller) stopSplitLocked() {
	c.split.stop(c.d.splitPath())
	c.split = nil
}

// reconcileSplit: a tunnel kept across a restart of this service lost its proxy with the old process, so
// the proxy is started again from the saved state; anything else is cleaned up.
func (c *controller) reconcileSplit(tunnelKept bool) {
	st, ok := readSplitState(c.d.splitPath())
	if !ok || !tunnelKept {
		if _, err := os.Stat(c.d.splitPath()); err == nil {
			c.mirror.Note("маршрутизация: после прошлого запуска остались маршруты — убираю")
		}
		c.cleanupSplitLeftovers()
		return
	}
	c.mirror.Note("маршрутизация: служба перезапущена при работающем туннеле — поднимаю DNS-прокси заново")
	saved := st.Routes
	removeNRPT()
	_ = os.Remove(c.d.splitPath())
	st.Routes = nil
	run, err := c.startSplitProxy(st)
	if err != nil {
		c.mirror.Note("маршрутизация: " + err.Error())
		return
	}
	// The service's own .conf says which families the tunnel has.
	conf, _ := os.ReadFile(c.d.confPath())
	v4, v6 := true, hasV6(confValues(string(conf), "Address"))
	if err := c.attach(run, confValues(string(conf), "AllowedIPs"), v4, v6); err != nil {
		c.mirror.Note("маршрутизация: " + err.Error())
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
