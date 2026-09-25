//go:build darwin

package main

import (
	"errors"

	"golang.org/x/sys/unix"
)

func processAlive(pid uint32) bool {
	return pid != 0 && unix.Kill(int(pid), 0) == nil
}

// awaitExit blocks until pid is gone: kqueue's EVFILT_PROC/NOTE_EXIT, macOS's own wait on a process
// that is not this one's child. ESRCH at registration means it has gone already.
func awaitExit(pid uint32) error {
	kq, err := unix.Kqueue()
	if err != nil {
		return err
	}
	defer unix.Close(kq)
	var ev unix.Kevent_t
	unix.SetKevent(&ev, int(pid), unix.EVFILT_PROC, unix.EV_ADD|unix.EV_ONESHOT)
	ev.Fflags = unix.NOTE_EXIT
	if _, err := unix.Kevent(kq, []unix.Kevent_t{ev}, nil, nil); err != nil {
		if errors.Is(err, unix.ESRCH) {
			return nil
		}
		return err
	}
	out := make([]unix.Kevent_t, 1)
	for {
		n, err := unix.Kevent(kq, nil, out, nil)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			return err
		}
		if n > 0 {
			return nil
		}
	}
}

// processName is the short name the kernel keeps for pid ("SenAWG"): what awg.sh's monitor checks
// alongside the pid (--app-cmd), so a pid reused by something else does not keep a tunnel up.
func processName(pid uint32) string {
	kp, err := unix.SysctlKinfoProc("kern.proc.pid", int(pid))
	if err != nil {
		return ""
	}
	name := kp.Proc.P_comm[:]
	for i, b := range name {
		if b == 0 {
			name = name[:i]
			break
		}
	}
	return string(name)
}
