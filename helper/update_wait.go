//go:build windows || linux

package main

import "time"

// waitOldTimeout is how long a seamless update waits for the application it replaces to close after
// `staged`. The application closes within a moment of the new window appearing; a minute is only for a
// machine that is stuck, and then the update is called off (the staged copy removed) instead of forcing
// the application shut under someone's hands.
const waitOldTimeout = 60 * time.Second

// waitGone reports whether pid exited within timeout.
func waitGone(pid uint32, timeout time.Duration) bool {
	for deadline := time.Now().Add(timeout); ; time.Sleep(100 * time.Millisecond) {
		if !processAlive(pid) {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
	}
}
