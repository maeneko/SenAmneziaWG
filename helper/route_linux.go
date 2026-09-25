//go:build linux

package main

import (
	"fmt"
	"net"
	"strings"

	"github.com/vishvananda/netlink"
)

// fwmarkTable is both the fwmark the daemon's own socket is tagged with (device.BindSetMark) and the
// routing table number that carries a full tunnel's default route. One fixed value is enough: one
// tunnel at a time, like the interface name.
//
// The scheme is wg-quick's own (src/wg-quick/linux.bash, add_default/remove_default upstream): traffic
// NOT carrying the mark is sent to this table, which for a full tunnel holds nothing but a default
// route out the interface; traffic that DOES carry the mark (the daemon's own encrypted packets) skips
// that rule and falls through to the normal table, so the tunnel cannot route its own packets into
// itself. `table main suppress_prefixlength 0` keeps every non-default route in the main table (a local
// subnet, another interface) working for ordinary traffic despite the rule ahead of it.
const fwmarkTable = 51888

// Rule priorities: both must sit below the main table's own rule (32766), or the main table's default
// route answers first and nothing ever reaches fwmarkTable. The suppress rule goes first, as in
// wg-quick (which lets the kernel pick 32764/32765 by adding it second): local and other specific
// routes win before the catch-all into the tunnel.
const (
	ruleMainNoDef = 32764 // "table main suppress_prefixlength 0"
	ruleToTunnel  = 32765 // "not fwmark N table N" — installed only for a full tunnel
)

// withFwmark inserts `fwmark=N` before the peer section (public_key=...): it must land among the
// device's own keys, not the peer's, or the daemon reads it as an unknown peer key and refuses the
// whole body.
func withFwmark(body string, mark int) string {
	idx := strings.Index(body, "public_key=")
	if idx < 0 {
		return body
	}
	return body[:idx] + fmt.Sprintf("fwmark=%d\n", mark) + body[idx:]
}

func linkByName(name string) (netlink.Link, error) {
	link, err := netlink.LinkByName(name)
	if err != nil {
		return nil, fmt.Errorf("интерфейс %s: %w", name, err)
	}
	return link, nil
}

// configureLink assigns every address in addrs (already validated CIDRs, IPv4 and IPv6 mixed) and
// brings the interface up at the given MTU.
func configureLink(iface string, addrs []string, mtu int) error {
	link, err := linkByName(iface)
	if err != nil {
		return err
	}
	for _, a := range addrs {
		ip, ipnet, err := net.ParseCIDR(a)
		if err != nil {
			return fmt.Errorf("адрес %s: %w", a, err)
		}
		ipnet.IP = ip
		if err := netlink.AddrAdd(link, &netlink.Addr{IPNet: ipnet}); err != nil {
			return fmt.Errorf("не удалось назначить адрес %s: %w", a, err)
		}
	}
	if mtu > 0 {
		if err := netlink.LinkSetMTU(link, mtu); err != nil {
			return fmt.Errorf("не удалось выставить MTU: %w", err)
		}
	}
	if err := netlink.LinkSetUp(link); err != nil {
		return fmt.Errorf("не удалось поднять интерфейс: %w", err)
	}
	return nil
}

// routeState is what applyRoutes did, so removeRoutes can undo exactly that (mirrors awg.sh's own
// EP_ROUTE/state bookkeeping).
type routeState struct {
	FullV4 bool     `json:"fullV4"`
	FullV6 bool     `json:"fullV6"`
	Extra  []string `json:"extra"` // specific (non-default) CIDRs routed onto the interface directly
}

// applyRoutes routes allowedIPs onto iface: 0.0.0.0/0 and ::/0 get the fwmark policy-routing dance
// (add_default in wg-quick's own terms), anything else becomes a plain route on the interface.
func applyRoutes(iface string, allowedIPs []string) (routeState, error) {
	link, err := linkByName(iface)
	if err != nil {
		return routeState{}, err
	}
	var st routeState
	for _, cidr := range allowedIPs {
		switch cidr {
		case "0.0.0.0/0":
			st.FullV4 = true
		case "::/0":
			st.FullV6 = true
		default:
			st.Extra = append(st.Extra, cidr)
		}
	}

	if st.FullV4 {
		if err := addDefault(link, netlink.FAMILY_V4); err != nil {
			return st, err
		}
	}
	if st.FullV6 {
		if err := addDefault(link, netlink.FAMILY_V6); err != nil {
			return st, err
		}
	}
	for _, cidr := range st.Extra {
		_, ipnet, err := net.ParseCIDR(cidr)
		if err != nil {
			return st, fmt.Errorf("allowed_ip %s: %w", cidr, err)
		}
		route := &netlink.Route{LinkIndex: link.Attrs().Index, Dst: ipnet}
		if err := netlink.RouteReplace(route); err != nil {
			return st, fmt.Errorf("не удалось добавить маршрут %s: %w", cidr, err)
		}
	}
	return st, nil
}

func addDefault(link netlink.Link, family int) error {
	_, dst, _ := net.ParseCIDR(defaultCIDR(family))
	route := &netlink.Route{LinkIndex: link.Attrs().Index, Dst: dst, Table: fwmarkTable}
	if err := netlink.RouteReplace(route); err != nil {
		return fmt.Errorf("не удалось добавить маршрут по умолчанию: %w", err)
	}
	toTunnel := netlink.NewRule()
	toTunnel.Family, toTunnel.Invert, toTunnel.Mark, toTunnel.Table, toTunnel.Priority =
		family, true, fwmarkTable, fwmarkTable, ruleToTunnel
	if err := netlink.RuleAdd(toTunnel); err != nil {
		return fmt.Errorf("не удалось добавить правило маршрутизации: %w", err)
	}
	keepMain := netlink.NewRule()
	keepMain.Family, keepMain.Table, keepMain.SuppressPrefixlen, keepMain.Priority =
		family, rtTableMain, 0, ruleMainNoDef
	if err := netlink.RuleAdd(keepMain); err != nil {
		return fmt.Errorf("не удалось добавить правило маршрутизации: %w", err)
	}
	return nil
}

func defaultCIDR(family int) string {
	if family == netlink.FAMILY_V6 {
		return "::/0"
	}
	return "0.0.0.0/0"
}

// removeRoutes undoes exactly what applyRoutes did. Best effort at every step, like awg.sh's teardown:
// one missing piece (the interface already gone with the daemon) must not stop the rest from being
// cleaned up.
func removeRoutes(st routeState) {
	if st.FullV4 {
		removeDefault(netlink.FAMILY_V4)
	}
	if st.FullV6 {
		removeDefault(netlink.FAMILY_V6)
	}
	// The specific (non-default) routes need no explicit removal: they live on the interface, and
	// vanish with it when the daemon exits and the kernel tears the interface down.
}

// legacyRuleToTunnel and legacyRuleMainNoDef are the priorities 0.6.2 and earlier used (after main, so
// they never took effect); removeDefault still deletes them so an upgrade leaves no stray rules behind.
const (
	legacyRuleToTunnel  = 51888
	legacyRuleMainNoDef = 51889
)

func removeDefault(family int) {
	for _, prio := range [][2]int{{ruleToTunnel, ruleMainNoDef}, {legacyRuleToTunnel, legacyRuleMainNoDef}} {
		toTunnel := netlink.NewRule()
		toTunnel.Family, toTunnel.Invert, toTunnel.Mark, toTunnel.Table, toTunnel.Priority =
			family, true, fwmarkTable, fwmarkTable, prio[0]
		_ = netlink.RuleDel(toTunnel)

		keepMain := netlink.NewRule()
		keepMain.Family, keepMain.Table, keepMain.SuppressPrefixlen, keepMain.Priority =
			family, rtTableMain, 0, prio[1]
		_ = netlink.RuleDel(keepMain)
	}
	// The table's own default route needs no removal: it lived on the interface and is gone with it.
}

// routeInterfaceFor answers the health check's "which interface would this go out of" (netinfo_linux.go),
// the same question route -n get answers on macOS and GetBestInterfaceEx answers on Windows.
func routeInterfaceFor(dst net.IP) (string, error) {
	routes, err := netlink.RouteGet(dst)
	if err != nil || len(routes) == 0 {
		return "", fmt.Errorf("маршрут не найден: %w", err)
	}
	link, err := netlink.LinkByIndex(routes[0].LinkIndex)
	if err != nil {
		return "", err
	}
	return link.Attrs().Name, nil
}

// rtTableMain mirrors golang.org/x/sys/unix.RT_TABLE_MAIN without pulling that whole package in
// just for one constant that never changes (254, fixed by the kernel's own rtnetlink ABI).
const rtTableMain = 254
