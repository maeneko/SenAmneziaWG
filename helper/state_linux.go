//go:build linux

package main

import (
	"encoding/json"
	"os"
)

// state is what the helper remembers across its own restarts: enough to tell whether the tunnel it
// left running is still there, and to undo routing and DNS if it is not (mirrors state_windows.go,
// with the extra bookkeeping tunnel_linux.go itself owns instead of a second OS service).
type state struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	StartedAt int64      `json:"startedAt"`
	PID       uint32     `json:"pid"`       // the app; lifetime.Watch is re-armed on it if it is still alive
	DaemonPID int        `json:"daemonPid"` // amneziawg-go's own pid — not our child after a helper restart
	Routes    routeState `json:"routes"`
	DNS       dnsState   `json:"dns"`
}

func (d dirs) saveState(s state) error {
	b, err := json.Marshal(s)
	if err != nil {
		return err
	}
	return os.WriteFile(d.statePath(), b, 0o600)
}

func (d dirs) loadState() state {
	var s state
	if b, err := os.ReadFile(d.statePath()); err == nil {
		_ = json.Unmarshal(b, &s)
	}
	return s
}

func (d dirs) clearState() { _ = os.Remove(d.statePath()) }
