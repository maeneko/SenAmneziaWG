//go:build linux

package main

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/google/nftables"
	"github.com/google/nftables/binaryutil"
	"github.com/google/nftables/expr"
	"github.com/vishvananda/netlink"

	"senawg-helper/internal/proto"
)

// Rules by program (`processName:`, `processPath:`) on Linux. The table of routes does not know which program
// opened a connection, but the kernel does know which cgroup a socket was made in, and nftables can match on that:
//
//  1. the service keeps three cgroups (v2) under /sys/fs/cgroup/senawg: proxy, direct, block;
//  2. every second it looks through /proc and moves the processes the rules name into the cgroup of their action
//     (their children are born in it);
//  3. an nftables chain in the OUTPUT hook marks the packets of sockets made in those cgroups: 51888 (the mark that
//     already skips the tunnel in route_linux.go) for «direct», 51889 for «through the tunnel», and rejects «block»;
//  4. `ip rule fwmark 51889 lookup 51888` and a default route in table 51888 send the second mark into the tunnel.
//
// A program that goes the default way needs none of this and is not touched. Connections already open when a
// process is moved keep the way they had; a program started just now goes the default way for up to a second.
const (
	cgroupRoot      = "/sys/fs/cgroup"
	cgroupBase      = "senawg"
	nftTableName    = "senawg"
	markToTunnel    = 51889
	ruleAppToTunnel = 32762
	scanEvery       = time.Second

	// nft's `reject with icmpx type port-unreachable`: the program fails at once instead of waiting.
	rejectIcmpxUnreach = 1
	rejectPortUnreach  = 1
)

// perAppAvailable: cgroup v2 is mounted at the root and the kernel answers nftables.
func perAppAvailable() bool {
	if _, err := os.Stat(filepath.Join(cgroupRoot, "cgroup.controllers")); err != nil {
		return false
	}
	c := &nftables.Conn{}
	_, err := c.ListTables()
	return err == nil
}

type linuxProcs struct{}

func (linuxProcs) List() []procInfo {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	var out []procInfo
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		exe, err := os.Readlink("/proc/" + e.Name() + "/exe")
		if err != nil {
			continue // a kernel thread, or one that has just exited
		}
		out = append(out, procInfo{PID: pid, Exe: strings.TrimSuffix(exe, " (deleted)"), Cgroup: cgroupOf(e.Name())})
	}
	return out
}

// cgroupOf reads the cgroup-v2 line («0::/path») of /proc/<pid>/cgroup.
func cgroupOf(pid string) string {
	b, err := os.ReadFile("/proc/" + pid + "/cgroup")
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(b), "\n") {
		if path, ok := strings.CutPrefix(line, "0::"); ok {
			return path
		}
	}
	return ""
}

type cgroupMover struct{}

func (cgroupMover) Move(pid int, dir string) error {
	f, err := os.OpenFile(filepath.Join(cgroupRoot, dir, "cgroup.procs"), os.O_WRONLY, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.WriteString(strconv.Itoa(pid))
	return err
}

// perApp is the running state.
type perApp struct {
	scanner *appScanner
	dirs    map[string]string // action → cgroup directory
	v6      bool
	tunnel  bool // the second mark was routed into the tunnel

	stopCh chan struct{}
	wg     sync.WaitGroup
	once   sync.Once
}

// startPerApp sets up the cgroups, the firewall marks and the scanner for the rules about programs; nil when there
// are none, or when every one of them goes the way the default goes.
func startPerApp(rules []proto.RoutingRule, final, tunnelIface string, v6 bool, daemonPID int) (*perApp, error) {
	apps := appRules(rules)
	if len(apps) == 0 {
		return nil, nil
	}
	dirs := map[string]string{}
	for _, r := range apps {
		// The default way needs no cgroup: a program that goes it is simply left alone.
		if (r.action == proto.ActionProxy && final == proto.FinalProxy) || (r.action == proto.ActionDirect && final == proto.FinalDirect) {
			continue
		}
		dirs[r.action] = filepath.Join(cgroupBase, r.action)
	}
	if len(dirs) == 0 {
		return nil, nil
	}
	if !perAppAvailable() {
		return nil, fmt.Errorf("правилам по программам нужны cgroup v2 и nftables, их нет в этой системе")
	}
	pa := &perApp{dirs: dirs, v6: v6, stopCh: make(chan struct{})}
	fail := func(err error) (*perApp, error) {
		pa.teardown()
		return nil, err
	}
	for _, dir := range dirs {
		if err := os.MkdirAll(filepath.Join(cgroupRoot, dir), 0o755); err != nil {
			return fail(fmt.Errorf("не удалось создать cgroup %s: %w", dir, err))
		}
	}
	if err := pa.installFirewall(); err != nil {
		return fail(err)
	}
	if _, ok := dirs[proto.ActionProxy]; ok {
		if err := pa.routeMarkIntoTunnel(tunnelIface); err != nil {
			return fail(err)
		}
	}
	skip := func(pid int) bool { return pid == os.Getpid() || pid == daemonPID }
	pa.scanner = newAppScanner(apps, dirs, linuxProcs{}, cgroupMover{}, skip)
	pa.scanner.Scan()
	pa.wg.Add(1)
	go func() {
		defer pa.wg.Done()
		t := time.NewTicker(scanEvery)
		defer t.Stop()
		for {
			select {
			case <-pa.stopCh:
				return
			case <-t.C:
				pa.scanner.Scan()
			}
		}
	}()
	return pa, nil
}

func cgroupID(dir string) (uint64, error) {
	var st syscall.Stat_t
	if err := syscall.Stat(filepath.Join(cgroupRoot, dir), &st); err != nil {
		return 0, err
	}
	return st.Ino, nil // on cgroup2 the inode number is the cgroup id nft compares with
}

// installFirewall makes the nftables table with one rule per action that has a cgroup.
func (pa *perApp) installFirewall() error {
	c := &nftables.Conn{}
	t := c.AddTable(&nftables.Table{Family: nftables.TableFamilyINet, Name: nftTableName})
	ch := c.AddChain(&nftables.Chain{Name: "output", Table: t, Type: nftables.ChainTypeRoute, Hooknum: nftables.ChainHookOutput, Priority: nftables.ChainPriorityMangle})
	for _, action := range []string{proto.ActionProxy, proto.ActionDirect, proto.ActionBlock} {
		dir, ok := pa.dirs[action]
		if !ok {
			continue
		}
		id, err := cgroupID(dir)
		if err != nil {
			return fmt.Errorf("cgroup %s: %w", dir, err)
		}
		// «socket cgroupv2 level 2 "senawg/<action>"»: the socket was made in that cgroup (level 2: two below the root).
		match := []expr.Any{
			&expr.Socket{Key: expr.SocketKeyCgroupv2, Level: 2, Register: 1},
			&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: binaryutil.NativeEndian.PutUint64(id)},
		}
		var verdict []expr.Any
		switch action {
		case proto.ActionProxy:
			verdict = markExprs(markToTunnel)
		case proto.ActionDirect:
			verdict = markExprs(fwmarkTable)
		default:
			verdict = []expr.Any{&expr.Reject{Type: rejectIcmpxUnreach, Code: rejectPortUnreach}}
		}
		c.AddRule(&nftables.Rule{Table: t, Chain: ch, Exprs: append(match, verdict...)})
	}
	if err := c.Flush(); err != nil {
		return fmt.Errorf("не удалось записать правила nftables: %w", err)
	}
	return nil
}

func markExprs(mark uint32) []expr.Any {
	return []expr.Any{
		&expr.Immediate{Register: 1, Data: binaryutil.NativeEndian.PutUint32(mark)},
		&expr.Meta{Key: expr.MetaKeyMARK, SourceRegister: true, Register: 1},
	}
}

// routeMarkIntoTunnel sends packets marked markToTunnel into the tunnel: a default route in the table the
// full-tunnel scheme already uses, and a rule that picks that table for this mark.
func (pa *perApp) routeMarkIntoTunnel(iface string) error {
	link, err := linkByName(iface)
	if err != nil {
		return err
	}
	families := []int{netlink.FAMILY_V4}
	if pa.v6 {
		families = append(families, netlink.FAMILY_V6)
	}
	for _, family := range families {
		dst := "0.0.0.0/0"
		if family == netlink.FAMILY_V6 {
			dst = "::/0"
		}
		_, ipn, _ := net.ParseCIDR(dst)
		if err := netlink.RouteReplace(&netlink.Route{LinkIndex: link.Attrs().Index, Dst: ipn, Table: fwmarkTable}); err != nil {
			return fmt.Errorf("маршрут по умолчанию для программ: %w", err)
		}
		rule := netlink.NewRule()
		rule.Family, rule.Mark, rule.Table, rule.Priority = family, markToTunnel, fwmarkTable, ruleAppToTunnel
		if err := netlink.RuleAdd(rule); err != nil && !os.IsExist(err) {
			return fmt.Errorf("правило маршрутизации для программ: %w", err)
		}
	}
	pa.tunnel = true
	return nil
}

// stop ends the scanner, puts the programs back and removes everything it made.
func (pa *perApp) stop() {
	if pa == nil {
		return
	}
	pa.once.Do(func() {
		close(pa.stopCh)
		pa.wg.Wait()
		if pa.scanner != nil {
			pa.scanner.Restore()
		}
		pa.teardown()
	})
}

func (pa *perApp) teardown() {
	removePerAppFirewall()
	if pa.tunnel {
		removeAppRules()
	}
	for _, dir := range pa.dirs {
		removeCgroup(dir)
	}
	_ = os.Remove(filepath.Join(cgroupRoot, cgroupBase))
}

func removePerAppFirewall() {
	c := &nftables.Conn{}
	c.DelTable(&nftables.Table{Family: nftables.TableFamilyINet, Name: nftTableName})
	_ = c.Flush() // absent is fine
}

func removeAppRules() {
	for _, family := range []int{netlink.FAMILY_V4, netlink.FAMILY_V6} {
		for i := 0; i < 8; i++ {
			rule := netlink.NewRule()
			rule.Family, rule.Mark, rule.Table, rule.Priority = family, markToTunnel, fwmarkTable, ruleAppToTunnel
			if netlink.RuleDel(rule) != nil {
				break
			}
		}
	}
}

// removeCgroup deletes a cgroup directory; the kernel refuses while a process is still in it, so it waits a moment.
func removeCgroup(dir string) {
	path := filepath.Join(cgroupRoot, dir)
	for i := 0; i < 20; i++ {
		if err := os.Remove(path); err == nil || os.IsNotExist(err) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// cleanupPerApp undoes what a service that was killed left: the firewall, the rules, and every process still
// sitting in one of the cgroups (put into the root: where each came from is not remembered across a crash).
func cleanupPerApp() {
	removePerAppFirewall()
	removeAppRules()
	base := filepath.Join(cgroupRoot, cgroupBase)
	entries, err := os.ReadDir(base)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir := filepath.Join(cgroupBase, e.Name())
		if b, err := os.ReadFile(filepath.Join(cgroupRoot, dir, "cgroup.procs")); err == nil {
			for _, pid := range strings.Fields(string(b)) {
				if n, err := strconv.Atoi(pid); err == nil {
					_ = cgroupMover{}.Move(n, "")
				}
			}
		}
		removeCgroup(dir)
	}
	_ = os.Remove(base)
}
