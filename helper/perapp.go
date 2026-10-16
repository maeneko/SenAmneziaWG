// perapp.go is the platform-independent half of «rules by program» (Linux: perapp_linux.go): which rule a running
// process falls under, and moving processes in and out of the cgroups the firewall marks by. Everything it touches
// is behind a small interface, so it is tested everywhere with a pretend /proc.
package main

import (
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"senawg-helper/internal/proto"
)

// procInfo is what is known about one running process.
type procInfo struct {
	PID int
	// Exe is the path of its executable, without the « (deleted)» the kernel appends after an update.
	Exe string
	// Cgroup is the process's cgroup (v2) as /proc/<pid>/cgroup names it: «/user.slice/…».
	Cgroup string
}

type procSource interface{ List() []procInfo }

// mover puts a process (all its threads) into a cgroup directory, relative to the cgroup root («senawg/proxy»,
// «/user.slice/…»).
type mover interface {
	Move(pid int, dir string) error
}

// appRule is one `processName:` or `processPath:` rule.
type appRule struct {
	action string
	path   bool // processPath, otherwise processName
	value  string
}

// appRules are the rules about programs, in the order the rules came.
func appRules(rules []proto.RoutingRule) []appRule {
	var out []appRule
	for _, r := range rules {
		switch r.Kind {
		case proto.KindProcessName:
			out = append(out, appRule{r.Action, false, r.Value})
		case proto.KindProcessPath:
			out = append(out, appRule{r.Action, true, r.Value})
		}
	}
	return out
}

// matchApp is the action of the first rule that names this executable: a name is the file's name, a path is the
// whole path.
func matchApp(rules []appRule, exe string) (string, bool) {
	if exe == "" {
		return "", false
	}
	base := filepath.Base(exe)
	for _, r := range rules {
		if (r.path && r.value == exe) || (!r.path && r.value == base) {
			return r.action, true
		}
	}
	return "", false
}

// appScanner finds the processes the rules name and keeps them in the cgroup of their action. Processes it did not
// move are never touched, and every one it moved goes back where it was (Restore).
type appScanner struct {
	rules []appRule
	// dirs: the cgroup directory for an action that needs one (a program whose way is the default way needs none).
	dirs map[string]string
	src  procSource
	mv   mover
	// skip: processes that are never moved (this service, the tunnel's daemon).
	skip func(pid int) bool

	mu     sync.Mutex
	origin map[int]string // pid → the cgroup it was in before
	where  map[int]string // pid → the directory we put it in
}

func newAppScanner(rules []appRule, dirs map[string]string, src procSource, mv mover, skip func(int) bool) *appScanner {
	return &appScanner{rules: rules, dirs: dirs, src: src, mv: mv, skip: skip, origin: map[int]string{}, where: map[int]string{}}
}

// Scan moves what needs moving and returns the pids it moved.
func (s *appScanner) Scan() []int {
	s.mu.Lock()
	defer s.mu.Unlock()
	var moved []int
	live := map[int]bool{}
	for _, p := range s.src.List() {
		live[p.PID] = true
		if s.skip != nil && s.skip(p.PID) {
			continue
		}
		action, ok := matchApp(s.rules, p.Exe)
		if !ok {
			continue
		}
		dir, need := s.dirs[action]
		if !need {
			continue // goes the default way: nothing to do
		}
		if strings.Trim(p.Cgroup, "/") == dir {
			continue // already there
		}
		if prev, mine := s.where[p.PID]; !mine || prev != dir {
			if _, seen := s.origin[p.PID]; !seen {
				s.origin[p.PID] = p.Cgroup
			}
		}
		if err := s.mv.Move(p.PID, dir); err != nil {
			continue // it exited between listing and moving, or it is not ours to move
		}
		s.where[p.PID] = dir
		moved = append(moved, p.PID)
	}
	for pid := range s.where { // forget the ones that are gone
		if !live[pid] {
			delete(s.where, pid)
			delete(s.origin, pid)
		}
	}
	sort.Ints(moved)
	return moved
}

// Restore puts every process it moved back into the cgroup it came from (the root when that has gone).
func (s *appScanner) Restore() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for pid, from := range s.origin {
		if _, ours := s.where[pid]; !ours {
			continue
		}
		if err := s.mv.Move(pid, strings.Trim(from, "/")); err != nil {
			_ = s.mv.Move(pid, "")
		}
		n++
	}
	s.origin = map[int]string{}
	s.where = map[int]string{}
	return n
}
