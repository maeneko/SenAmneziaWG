package main

import (
	"errors"
	"reflect"
	"testing"

	"senawg-helper/internal/proto"
)

type fakeProcs struct{ procs []procInfo }

func (f *fakeProcs) List() []procInfo { return f.procs }

type fakeMover struct {
	moves []string
	fail  map[int]bool
	procs *fakeProcs
}

// Move records the move and puts the process there, as the kernel would.
func (m *fakeMover) Move(pid int, dir string) error {
	if m.fail[pid] {
		return errors.New("no such process")
	}
	m.moves = append(m.moves, itoa(pid)+"→"+dir)
	for i := range m.procs.procs {
		if m.procs.procs[i].PID == pid {
			m.procs.procs[i].Cgroup = "/" + dir
		}
	}
	return nil
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	s := ""
	for ; n > 0; n /= 10 {
		s = string(rune('0'+n%10)) + s
	}
	return s
}

func rule(action, kind, value string) proto.RoutingRule {
	return proto.RoutingRule{Action: action, Kind: kind, Value: value}
}

func TestMatchApp(t *testing.T) {
	rules := appRules([]proto.RoutingRule{
		rule(proto.ActionProxy, proto.KindSuffix, "example.com"), // not about programs
		rule(proto.ActionBlock, proto.KindProcessPath, "/opt/evil/spotify"),
		rule(proto.ActionProxy, proto.KindProcessName, "spotify"),
		rule(proto.ActionDirect, proto.KindProcessName, "Telegram"),
	})
	if len(rules) != 3 {
		t.Fatalf("rules: %v", rules)
	}
	for exe, want := range map[string]string{
		"/usr/bin/spotify":  proto.ActionProxy,
		"/opt/evil/spotify": proto.ActionBlock, // the path rule comes first
		"/usr/bin/Telegram": proto.ActionDirect,
		"/usr/bin/telegram": "", // names are case-sensitive on Linux
		"/usr/bin/firefox":  "",
		"":                  "",
	} {
		got, ok := matchApp(rules, exe)
		if want == "" && ok || want != "" && (!ok || got != want) {
			t.Errorf("matchApp(%q) = %q %v, want %q", exe, got, ok, want)
		}
	}
}

func newScanner(rules []proto.RoutingRule, procs []procInfo, dirs map[string]string) (*appScanner, *fakeMover, *fakeProcs) {
	src := &fakeProcs{procs: procs}
	mv := &fakeMover{procs: src, fail: map[int]bool{}}
	return newAppScanner(appRules(rules), dirs, src, mv, func(pid int) bool { return pid == 1 }), mv, src
}

func TestScannerMovesAndRestores(t *testing.T) {
	s, mv, src := newScanner(
		[]proto.RoutingRule{rule(proto.ActionProxy, proto.KindProcessName, "spotify"), rule(proto.ActionBlock, proto.KindProcessName, "ads")},
		[]procInfo{
			{PID: 1, Exe: "/usr/bin/spotify", Cgroup: "/init"}, // skipped: this service's own
			{PID: 10, Exe: "/usr/bin/spotify", Cgroup: "/user.slice/app-spotify.scope"},
			{PID: 11, Exe: "/usr/bin/spotify", Cgroup: "/user.slice/app-spotify.scope"},
			{PID: 20, Exe: "/usr/bin/firefox", Cgroup: "/user.slice/app-firefox.scope"},
			{PID: 30, Exe: "/usr/bin/ads", Cgroup: "/user.slice/x"}, // an action with no cgroup: the default way
		},
		map[string]string{proto.ActionProxy: "senawg/proxy"},
	)
	if moved := s.Scan(); !reflect.DeepEqual(moved, []int{10, 11}) {
		t.Fatalf("moved %v", moved)
	}
	if !reflect.DeepEqual(mv.moves, []string{"10→senawg/proxy", "11→senawg/proxy"}) {
		t.Fatalf("moves %v", mv.moves)
	}
	// A second pass finds them in place and does nothing.
	if moved := s.Scan(); len(moved) != 0 {
		t.Fatalf("second scan moved %v", moved)
	}
	// A new process of the same program is picked up.
	src.procs = append(src.procs, procInfo{PID: 12, Exe: "/usr/bin/spotify", Cgroup: "/user.slice/new"})
	if moved := s.Scan(); !reflect.DeepEqual(moved, []int{12}) {
		t.Fatalf("new process: %v", moved)
	}

	if n := s.Restore(); n != 3 {
		t.Fatalf("Restore put back %d", n)
	}
	back := map[string]bool{}
	for _, m := range mv.moves[3:] {
		back[m] = true
	}
	for _, want := range []string{"10→user.slice/app-spotify.scope", "11→user.slice/app-spotify.scope", "12→user.slice/new"} {
		if !back[want] {
			t.Errorf("missing %s in %v", want, mv.moves[3:])
		}
	}
	if len(s.where) != 0 || len(s.origin) != 0 {
		t.Fatal("Restore must forget what it put back")
	}
}

func TestScannerSurvivesExitsAndFailures(t *testing.T) {
	s, mv, src := newScanner(
		[]proto.RoutingRule{rule(proto.ActionProxy, proto.KindProcessPath, "/usr/bin/app")},
		[]procInfo{{PID: 5, Exe: "/usr/bin/app", Cgroup: "/a"}, {PID: 6, Exe: "/usr/bin/app", Cgroup: "/b"}},
		map[string]string{proto.ActionProxy: "senawg/proxy"},
	)
	mv.fail[5] = true // gone between listing and moving
	if moved := s.Scan(); !reflect.DeepEqual(moved, []int{6}) {
		t.Fatalf("moved %v", moved)
	}
	// 6 exits: forgotten, and Restore has nothing to put back for it.
	src.procs = nil
	s.Scan()
	if n := s.Restore(); n != 0 {
		t.Fatalf("Restore put back %d", n)
	}
	// A restore whose original cgroup is gone falls back to the root.
	s2, mv2, _ := newScanner(
		[]proto.RoutingRule{rule(proto.ActionProxy, proto.KindProcessName, "x")},
		[]procInfo{{PID: 7, Exe: "/bin/x", Cgroup: "/gone.scope"}},
		map[string]string{proto.ActionProxy: "senawg/proxy"},
	)
	s2.Scan()
	mv2.fail = map[int]bool{} // moves work, but we make the first restore attempt fail below
	failOnce := &failingFirst{inner: mv2, dir: "gone.scope"}
	s2.mv = failOnce
	s2.Restore()
	if !reflect.DeepEqual(failOnce.calls, []string{"gone.scope", ""}) {
		t.Fatalf("restore attempts: %v", failOnce.calls)
	}
}

type failingFirst struct {
	inner *fakeMover
	dir   string
	calls []string
}

func (f *failingFirst) Move(pid int, dir string) error {
	f.calls = append(f.calls, dir)
	if dir == f.dir {
		return errors.New("no such cgroup")
	}
	return f.inner.Move(pid, dir)
}
