//go:build linux

package main

import (
	"errors"
	"time"

	"golang.org/x/sys/unix"
)

// processAlive is used by reconcile: is the app named in state.json still the one running.
func processAlive(pid uint32) bool {
	if pid == 0 {
		return false
	}
	return unix.Kill(int(pid), 0) == nil
}

// awaitExit blocks until pid is gone. pidfd_open (Linux 5.3+) makes this an actual wait; on an older
// kernel (ENOSYS) or one where it is denied (seccomp, an unprivileged pid namespace), it falls back to
// polling kill(pid, 0) — cruder, but every kernel this helper otherwise supports can still do it.
func awaitExit(pid uint32) error {
	fd, err := unix.PidfdOpen(int(pid), 0)
	if err != nil {
		if errors.Is(err, unix.ESRCH) {
			return nil // already gone
		}
		return awaitExitPolled(pid)
	}
	defer unix.Close(fd)
	pfd := []unix.PollFd{{Fd: int32(fd), Events: unix.POLLIN}}
	for {
		n, err := unix.Poll(pfd, -1)
		if err != nil {
			if errors.Is(err, unix.EINTR) {
				continue
			}
			return err
		}
		if n > 0 {
			return nil
		}
	}
}

func awaitExitPolled(pid uint32) error {
	t := time.NewTicker(500 * time.Millisecond)
	defer t.Stop()
	for range t.C {
		if !processAlive(pid) {
			return nil
		}
	}
	return nil
}
