package main

import (
	"encoding/json"
	"os"
)

// state is what the helper itself needs to remember across its own restarts: which tunnel the running
// tunnel service belongs to. The service is the source of truth for whether it runs at all.
type state struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	StartedAt int64  `json:"startedAt"`
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
