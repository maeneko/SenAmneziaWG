//go:build linux

package main

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"

	"github.com/vishvananda/netlink"
)

// svcLog appends one of the service's own lines to daemon.log, next to amneziawg-go's: the app already
// follows that file (linuxBackend.ts), so these reach the journal as [tunnel] lines without a new
// channel. The "LEVEL: " prefix is the one parseDaemonLine (src/main/logger.ts) reads. Opened per line:
// it is written rarely, and it must work before up opens the file for the daemon and after down closes it.
func svcLog(level, format string, args ...any) {
	f, err := os.OpenFile(layout().daemonLog(), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	msg := strings.ReplaceAll(fmt.Sprintf(format, args...), "\n", " | ")
	fmt.Fprintf(f, "%s: служба: %s\n", level, msg)
}

func svcInfo(format string, args ...any)  { svcLog("INFO", format, args...) }
func svcWarn(format string, args ...any)  { svcLog("WARNING", format, args...) }
func svcError(format string, args ...any) { svcLog("ERROR", format, args...) }

// logNetworkSnapshot writes what `ip rule`, `ip route show table all` (the parts that matter),
// `ip route get` and /etc/resolv.conf would show right now: enough to tell from a user's journal alone
// whether traffic can reach the tunnel, and whether the daemon's own packets can still reach the server.
func logNetworkSnapshot(why, endpointIP string) {
	svcInfo("снимок сети (%s):", why)
	logLink()
	for _, fam := range []int{netlink.FAMILY_V4, netlink.FAMILY_V6} {
		logRules(fam)
	}
	logTableRoutes(fwmarkTable)
	logDefaultRoutes()
	for _, probe := range []string{"1.1.1.1", "2606:4700:4700::1111"} {
		logRouteGet(probe, 0, "обычный трафик")
	}
	if endpointIP != "" {
		logRouteGet(endpointIP, 0, "сервер, без метки")
		logRouteGet(endpointIP, fwmarkTable, "сервер, пакеты демона")
	}
	logResolvConf()
}

func logLink() {
	link, err := netlink.LinkByName(tunnelName)
	if err != nil {
		svcWarn("  %s: нет интерфейса (%v)", tunnelName, err)
		return
	}
	a := link.Attrs()
	var addrs []string
	if list, err := netlink.AddrList(link, netlink.FAMILY_ALL); err == nil {
		for _, ad := range list {
			addrs = append(addrs, ad.IPNet.String())
		}
	}
	svcInfo("  %s: состояние %s, флаги %s, MTU %d, адреса [%s]", tunnelName, a.OperState, a.Flags, a.MTU, strings.Join(addrs, ", "))
}

func logRules(family int) {
	rules, err := netlink.RuleList(family)
	if err != nil {
		svcWarn("  ip rule (%s): %v", familyName(family), err)
		return
	}
	parts := make([]string, 0, len(rules))
	for _, r := range rules {
		parts = append(parts, describeRule(r))
	}
	svcInfo("  ip rule %s: %s", familyName(family), strings.Join(parts, "; "))
}

// describeRule renders r the way `ip rule` would, e.g. "32765: not fwmark 0xcab0 lookup 51888".
func describeRule(r netlink.Rule) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%d:", r.Priority)
	if r.Invert {
		b.WriteString(" not")
	}
	if r.Src != nil {
		fmt.Fprintf(&b, " from %s", r.Src)
	} else {
		b.WriteString(" from all")
	}
	if r.Dst != nil {
		fmt.Fprintf(&b, " to %s", r.Dst)
	}
	if r.Mark != 0 {
		fmt.Fprintf(&b, " fwmark %#x", r.Mark)
	}
	if r.IifName != "" {
		fmt.Fprintf(&b, " iif %s", r.IifName)
	}
	if r.OifName != "" {
		fmt.Fprintf(&b, " oif %s", r.OifName)
	}
	fmt.Fprintf(&b, " lookup %s", tableName(r.Table))
	if r.SuppressPrefixlen >= 0 {
		fmt.Fprintf(&b, " suppress_prefixlength %d", r.SuppressPrefixlen)
	}
	return b.String()
}

func logTableRoutes(table int) {
	routes, err := netlink.RouteListFiltered(netlink.FAMILY_ALL, &netlink.Route{Table: table}, netlink.RT_FILTER_TABLE)
	if err != nil {
		svcWarn("  таблица %d: %v", table, err)
		return
	}
	if len(routes) == 0 {
		svcInfo("  таблица %d: пусто", table)
		return
	}
	parts := make([]string, 0, len(routes))
	for _, r := range routes {
		parts = append(parts, describeRoute(r))
	}
	svcInfo("  таблица %d: %s", table, strings.Join(parts, "; "))
}

// logDefaultRoutes lists the main table's default routes: where traffic goes when the tunnel does not
// take it, and where the daemon's own packets to the server must go.
func logDefaultRoutes() {
	var parts []string
	for _, fam := range []int{netlink.FAMILY_V4, netlink.FAMILY_V6} {
		routes, err := netlink.RouteListFiltered(fam, &netlink.Route{Table: rtTableMain}, netlink.RT_FILTER_TABLE)
		if err != nil {
			svcWarn("  main (%s): %v", familyName(fam), err)
			continue
		}
		for _, r := range routes {
			if r.Dst == nil || isDefault(r.Dst) {
				parts = append(parts, describeRoute(r))
			}
		}
	}
	if len(parts) == 0 {
		svcWarn("  main: нет маршрута по умолчанию — без туннеля у системы нет выхода в интернет")
		return
	}
	svcInfo("  main, маршруты по умолчанию: %s", strings.Join(parts, "; "))
}

func logRouteGet(target string, mark uint32, label string) {
	ip := net.ParseIP(target)
	if ip == nil {
		return
	}
	routes, err := netlink.RouteGetWithOptions(ip, &netlink.RouteGetOptions{Mark: mark})
	if err != nil || len(routes) == 0 {
		svcWarn("  маршрут до %s (%s): нет (%v)", target, label, err)
		return
	}
	svcInfo("  маршрут до %s (%s): %s", target, label, describeRoute(routes[0]))
}

// describeRoute renders r like `ip route`, e.g. "default via 192.168.1.1 dev wlan0 table main".
func describeRoute(r netlink.Route) string {
	var b strings.Builder
	if r.Dst == nil || isDefault(r.Dst) {
		b.WriteString("default")
	} else {
		b.WriteString(r.Dst.String())
	}
	if r.Gw != nil {
		fmt.Fprintf(&b, " via %s", r.Gw)
	}
	if r.LinkIndex > 0 {
		if l, err := netlink.LinkByIndex(r.LinkIndex); err == nil {
			fmt.Fprintf(&b, " dev %s", l.Attrs().Name)
		} else {
			fmt.Fprintf(&b, " dev #%d", r.LinkIndex)
		}
	}
	if r.Src != nil {
		fmt.Fprintf(&b, " src %s", r.Src)
	}
	if r.Priority > 0 {
		fmt.Fprintf(&b, " metric %d", r.Priority)
	}
	if r.Table > 0 {
		fmt.Fprintf(&b, " table %s", tableName(r.Table))
	}
	return b.String()
}

func logResolvConf() {
	const path = "/etc/resolv.conf"
	target, _ := filepath.EvalSymlinks(path)
	servers := readResolvConf()
	where := path
	if target != "" && target != path {
		where = path + " → " + target
	}
	if len(servers) == 0 {
		svcWarn("  %s: ни одного nameserver", where)
		return
	}
	svcInfo("  %s: nameserver %s", where, strings.Join(servers, ", "))
}

func isDefault(n *net.IPNet) bool {
	ones, _ := n.Mask.Size()
	return ones == 0
}

func familyName(f int) string {
	if f == netlink.FAMILY_V6 {
		return "IPv6"
	}
	return "IPv4"
}

func tableName(t int) string {
	switch t {
	case rtTableMain:
		return "main"
	case 255:
		return "local"
	case 253:
		return "default"
	}
	return fmt.Sprint(t)
}

func kernelRelease() string {
	b, err := os.ReadFile("/proc/sys/kernel/osrelease")
	if err != nil {
		return "?"
	}
	return strings.TrimSpace(string(b))
}
