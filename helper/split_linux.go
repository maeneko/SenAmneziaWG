//go:build linux

package main

import (
	"fmt"
	"net"
	"net/netip"
	"os"
	"syscall"

	"github.com/vishvananda/netlink"

	"senawg-helper/internal/proto"
	"senawg-helper/internal/splitdns"
)

// «Что идёт через VPN» on Linux. The tunnel's peer keeps AllowedIPs = 0/0 and the routing decides:
//
//	exclude  the full-tunnel scheme of route_linux.go stays; every address of a listed name gets a rule
//	         `to ADDR lookup main` ahead of it (priority ruleSplitDirect), so it leaves by the physical default;
//	include  no default route into the tunnel at all; every address of a listed name gets a host route
//	         on the interface.
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
	mode  string
	proxy *splitdns.Proxy
	// include mode: the tunnel's DNS servers are routed into the tunnel for as long as it runs.
	dnsRoutes []netip.Addr
	router    *linuxRouter
}

// linuxRouter implements splitdns.Router for one mode.
type linuxRouter struct {
	mode  string
	index int
}

func hostNet(ip netip.Addr) *net.IPNet {
	return &net.IPNet{IP: ip.AsSlice(), Mask: net.CIDRMask(ip.BitLen(), ip.BitLen())}
}

func familyOf(ip netip.Addr) int {
	if ip.Is6() {
		return netlink.FAMILY_V6
	}
	return netlink.FAMILY_V4
}

func (r *linuxRouter) directRule(ip netip.Addr) *netlink.Rule {
	rule := netlink.NewRule()
	rule.Family, rule.Dst, rule.Table, rule.Priority = familyOf(ip), hostNet(ip), rtTableMain, ruleSplitDirect
	return rule
}

func (r *linuxRouter) Divert(ip netip.Addr) error {
	if r.mode == proto.SplitInclude {
		return netlink.RouteReplace(&netlink.Route{LinkIndex: r.index, Dst: hostNet(ip)})
	}
	if err := netlink.RuleAdd(r.directRule(ip)); err != nil && !os.IsExist(err) {
		return err
	}
	return nil
}

func (r *linuxRouter) Release(ip netip.Addr) error {
	if r.mode == proto.SplitInclude {
		return netlink.RouteDel(&netlink.Route{LinkIndex: r.index, Dst: hostNet(ip)})
	}
	return netlink.RuleDel(r.directRule(ip))
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

// includeAllowed is what applyRoutes gets in include mode: the peer's specific ranges, without the two
// defaults — nothing may flow into the tunnel unless a listed name asked for it.
func includeAllowed(allowed []string) []string {
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

// startSplit brings the proxy up. endpoint is the server's address: never diverted.
func startSplit(req *proto.Request, endpoint string) (*splitRun, error) {
	link, err := linkByName(tunnelName)
	if err != nil {
		return nil, err
	}
	router := &linuxRouter{mode: req.Split.Mode, index: link.Attrs().Index}
	skip := map[netip.Addr]bool{}
	if ip, err := netip.ParseAddr(endpoint); err == nil {
		skip[ip.Unmap()] = true
	}
	tunnelDNS := splitdns.ParseAddrs(req.Dns)
	for _, ip := range tunnelDNS {
		skip[ip] = true // their way is fixed, below
	}
	routes := splitdns.NewRouteSet(router, func(ip netip.Addr) bool { return skip[ip] })

	run := &splitRun{mode: req.Split.Mode, router: router}
	cleanup := func() {
		for _, ip := range run.dnsRoutes {
			_ = router.Release(ip)
		}
		routes.Close()
	}
	if req.Split.Mode == proto.SplitInclude {
		for _, ip := range tunnelDNS {
			if err := router.Divert(ip); err != nil {
				cleanup()
				return nil, fmt.Errorf("маршрут до DNS туннеля %s: %w", ip, err)
			}
			run.dnsRoutes = append(run.dnsRoutes, ip)
		}
	}

	var dial net.Dialer
	tunnel := &splitdns.Upstream{Servers: tunnelDNS, Dial: dial.DialContext}
	direct := &splitdns.Upstream{Servers: systemResolvers(), Dial: markedDialer(fwmarkTable)}
	cfg := splitdns.Config{
		Mode: req.Split.Mode, Domains: req.Split.Domains, TunnelV6: hasV6(req.Address),
		Routes: routes, Logf: func(f string, a ...any) { svcInfo("раздельный режим: "+f, a...) },
	}
	switch {
	case len(tunnelDNS) == 0 && len(direct.Servers) == 0:
		cleanup()
		return nil, fmt.Errorf("не найден ни один DNS-сервер: ни у туннеля, ни в системе")
	case len(tunnelDNS) == 0:
		svcWarn("раздельный режим: у туннеля нет DNS — вопросы идут в DNS системы")
		cfg.Tunnel, cfg.Direct = direct, direct
	case len(direct.Servers) == 0:
		svcWarn("раздельный режим: DNS системы не найден — все вопросы идут в DNS туннеля")
		cfg.Tunnel = tunnel
	default:
		cfg.Tunnel, cfg.Direct = tunnel, direct
	}

	addr := net.JoinHostPort(splitListen.String(), "53")
	udp, err := net.ListenPacket("udp", addr)
	if err != nil {
		cleanup()
		return nil, fmt.Errorf("не удалось занять %s (udp): %w", addr, err)
	}
	tcp, err := net.Listen("tcp", addr)
	if err != nil {
		_ = udp.Close()
		cleanup()
		return nil, fmt.Errorf("не удалось занять %s (tcp): %w", addr, err)
	}
	run.proxy = splitdns.New(cfg)
	run.proxy.Serve(udp, tcp)
	svcInfo("раздельный режим: %s, сайтов в списке %d, DNS туннеля %v, DNS системы %v",
		req.Split.Mode, len(req.Split.Domains), tunnelDNS, direct.Servers)
	return run, nil
}

// stop closes the proxy, which takes its own routes with it, and then the fixed ones.
func (s *splitRun) stop() {
	if s == nil {
		return
	}
	s.proxy.Close()
	for _, ip := range s.dnsRoutes {
		_ = s.router.Release(ip)
	}
}

// cleanupSplitRules removes every rule the proxy may have left behind (after a crash, with no state to
// say which): all of them live at one priority, so deleting until none is left is enough.
func cleanupSplitRules() {
	for _, family := range []int{netlink.FAMILY_V4, netlink.FAMILY_V6} {
		for i := 0; i < maxRulesCleanup; i++ {
			rule := netlink.NewRule()
			rule.Family, rule.Priority = family, ruleSplitDirect
			if netlink.RuleDel(rule) != nil {
				break
			}
		}
	}
}

// maxRulesCleanup bounds that loop: more rules than the proxy ever adds.
const maxRulesCleanup = 20000
