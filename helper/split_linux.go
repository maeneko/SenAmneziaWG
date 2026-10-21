//go:build linux

package main

import (
	"fmt"
	"net"
	"net/netip"
	"os"
	"sync/atomic"
	"syscall"

	"github.com/vishvananda/netlink"

	"senawg-helper/internal/proto"
	"senawg-helper/internal/splitdns"
)

// «Маршрутизация» on Linux. The tunnel's peer keeps AllowedIPs = 0/0 and the routing decides:
//
//	default proxy   the full-tunnel scheme of route_linux.go stays; an address a rule sends direct gets a rule
//	                `to ADDR lookup main` ahead of it (priority ruleSplitDirect), so it leaves by the physical default;
//	default direct  no default route into the tunnel at all; an address a rule sends through the tunnel gets a host
//	                route on the interface;
//	block           a black-hole route for an `ip:` rule; a name under a block rule gets NXDOMAIN and no route.
//
// The names are seen by a DNS proxy on splitListen (internal/splitdns), which the system's resolver is
// pointed at while the tunnel is up.
const (
	// ruleSplitDirect sits ahead of the suppress rule (32764): its table is main, which holds the physical default.
	ruleSplitDirect = 32763
)

// splitListen is where the proxy answers: the whole 127/8 is loopback on Linux, so no address needs adding.
var splitListen = netip.MustParseAddr("127.77.0.1")

// splitRun is the running proxy and what it needs undone.
type splitRun struct {
	final  string
	router *linuxRouter
	routes *splitdns.RouteSet
	// nil when no rule is about names: then the system's DNS is left as it is (the tunnel's).
	proxy *splitdns.Proxy
	// Networks black-holed by `ip:` rules: not tied to the interface, so a crash must be able to find them.
	blocks []string
}

// linuxRouter implements splitdns.Router.
type linuxRouter struct {
	index int
	// The daemon died: the interface is gone, and what goes «through the tunnel» is black-holed instead.
	dead atomic.Bool
}

func prefixNet(p netip.Prefix) *net.IPNet {
	return &net.IPNet{IP: p.Addr().AsSlice(), Mask: net.CIDRMask(p.Bits(), p.Addr().BitLen())}
}

func familyOf(ip netip.Addr) int {
	if ip.Is6() {
		return netlink.FAMILY_V6
	}
	return netlink.FAMILY_V4
}

func (r *linuxRouter) directRule(p netip.Prefix) *netlink.Rule {
	rule := netlink.NewRule()
	rule.Family, rule.Dst, rule.Table, rule.Priority = familyOf(p.Addr()), prefixNet(p), rtTableMain, ruleSplitDirect
	return rule
}

func (r *linuxRouter) route(p netip.Prefix, way splitdns.Way) *netlink.Route {
	if way == splitdns.WayBlock || (way == splitdns.WayTunnel && r.dead.Load()) {
		return &netlink.Route{Dst: prefixNet(p), Type: syscall.RTN_BLACKHOLE}
	}
	return &netlink.Route{LinkIndex: r.index, Dst: prefixNet(p)}
}

func (r *linuxRouter) Route(p netip.Prefix, way splitdns.Way) error {
	if way == splitdns.WayDirect {
		if err := netlink.RuleAdd(r.directRule(p)); err != nil && !os.IsExist(err) {
			return err
		}
		return nil
	}
	return netlink.RouteReplace(r.route(p, way))
}

func (r *linuxRouter) Unroute(p netip.Prefix, way splitdns.Way) error {
	if way == splitdns.WayDirect {
		return netlink.RuleDel(r.directRule(p))
	}
	return netlink.RouteDel(r.route(p, way))
}

// markedDialer opens sockets that skip the tunnel's routing table (the same fwmark the daemon's own
// socket carries), so a question for the system's DNS leaves by the physical network even in a full tunnel.
func markedDialer(mark int) splitdns.Dialer {
	d := net.Dialer{Control: func(_, _ string, c syscall.RawConn) error {
		var serr error
		if err := c.Control(func(fd uintptr) { serr = syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_MARK, mark) }); err != nil {
			return err
		}
		return serr
	}}
	return d.DialContext
}

// directAllowed is what applyRoutes gets when the default is direct: the peer's specific ranges, without the two
// defaults — nothing may flow into the tunnel unless a rule sent it there.
func directAllowed(allowed []string) []string {
	var out []string
	for _, a := range allowed {
		if a != "0.0.0.0/0" && a != "::/0" {
			out = append(out, a)
		}
	}
	return out
}

// systemResolvers are the servers the system asks now, read before the proxy takes their place.
func systemResolvers() []netip.Addr {
	for _, p := range []string{"/run/systemd/resolve/resolv.conf", "/etc/resolv.conf"} {
		if b, err := os.ReadFile(p); err == nil {
			if got := splitdns.ParseResolvConf(string(b)); len(got) > 0 {
				return got
			}
		}
	}
	return nil
}

// startSplit brings the proxy up. endpoint is the server's address: never routed by name.
func startSplit(req *proto.Request, endpoint string) (*splitRun, error) {
	link, err := linkByName(tunnelName)
	if err != nil {
		return nil, err
	}
	st := splitStateFrom(req, endpoint, systemResolvers(), hasV6(req.Address))
	router := &linuxRouter{index: link.Attrs().Index}
	skip := map[netip.Addr]bool{}
	if ip, err := netip.ParseAddr(endpoint); err == nil {
		skip[ip.Unmap()] = true
	}
	tunnelDNS := splitdns.ParseAddrs(req.Dns)
	for _, ip := range tunnelDNS {
		skip[ip] = true // their way is fixed, below
	}
	routes := splitdns.NewRouteSet(router, func(ip netip.Addr) bool { return skip[ip] })
	run := &splitRun{final: st.Final, router: router}
	if st.Final == proto.FinalDirect {
		// Nothing goes into the tunnel by default, so the tunnel's own DNS has to be sent there.
		for _, ip := range tunnelDNS {
			if err := routes.Pin(splitdns.HostPrefix(ip), splitdns.WayTunnel); err != nil {
				routes.Close()
				return nil, fmt.Errorf("маршрут до DNS туннеля %s: %w", ip, err)
			}
		}
	}
	for _, e := range staticRoutes(st) {
		if err := routes.Pin(e.Prefix, e.Way); err != nil {
			svcWarn("маршрутизация: правило ip:%s: %v", e.Prefix, err)
			continue
		}
		if e.Way == splitdns.WayBlock {
			run.blocks = append(run.blocks, e.Prefix.String())
		}
	}

	run.routes = routes
	// Rules about programs and networks need no DNS proxy; only rules about names do.
	if len(dnsRules(st.Rules)) > 0 {
		proxy, err := buildProxy(st, routes, markedDialer(fwmarkTable), func(f string, a ...any) { svcInfo("маршрутизация: "+f, a...) })
		if err != nil {
			routes.Close()
			return nil, err
		}
		run.proxy = proxy
	}
	svcInfo("маршрутизация: по умолчанию %s, правил %d, DNS туннеля %v, DNS системы %v", wordOf(st.Final), len(st.Rules), st.TunnelNS, st.DirectNS)
	return run, nil
}

func wordOf(final string) string {
	if final == proto.FinalDirect {
		return "напрямую"
	}
	return "через туннель"
}

// stop closes the proxy, which takes its routes with it (or the routes alone, when there is no proxy).
func (s *splitRun) stop() {
	if s == nil {
		return
	}
	if s.proxy != nil {
		s.proxy.Close()
		return
	}
	s.routes.Close()
}

// failClosed runs when the daemon has exited by itself. The routes of what the rules send through the tunnel
// lived on its interface and are gone: each becomes a black hole, or its traffic would take the physical
// default. They are named among the blocks, so a crash of this service after it still finds them.
func (s *splitRun) failClosed() {
	if s == nil {
		return
	}
	s.router.dead.Store(true)
	for _, e := range s.routes.Entries() {
		if e.Way != splitdns.WayTunnel {
			continue
		}
		if err := s.router.Route(e.Prefix, e.Way); err != nil {
			svcWarn("маршрутизация: не удалось перекрыть %s: %v", e.Prefix, err)
			continue
		}
		s.blocks = append(s.blocks, e.Prefix.String())
	}
}

// cleanupSplitRules removes what the proxy may have left behind (after a crash): every rule lives at one
// priority, so deleting until none is left is enough, and the black holes are named in the state file.
func cleanupSplitRules(blocks []string) {
	for _, family := range []int{netlink.FAMILY_V4, netlink.FAMILY_V6} {
		for i := 0; i < maxRulesCleanup; i++ {
			rule := netlink.NewRule()
			rule.Family, rule.Priority = family, ruleSplitDirect
			if netlink.RuleDel(rule) != nil {
				break
			}
		}
	}
	r := &linuxRouter{}
	for _, b := range blocks {
		if p, err := netip.ParsePrefix(b); err == nil {
			_ = r.Unroute(p, splitdns.WayBlock)
		}
	}
}

// maxRulesCleanup bounds that loop: more rules than the proxy ever adds.
const maxRulesCleanup = 20000

func (s *splitRun) blocksOrNil() []string {
	if s == nil {
		return nil
	}
	return s.blocks
}
