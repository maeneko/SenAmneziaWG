package main

import (
	"fmt"

	"golang.org/x/sys/windows"
)

// The service and the tunnel it runs are Windows services: they have no parent process and nothing ties
// them to the app. So the app's lifetime is watched explicitly (internal/lifetime decides what follows
// from it), or both would outlive the app — including when it is killed from Task Manager.

func openForWait(pid uint32) (windows.Handle, error) {
	if pid == 0 {
		return 0, fmt.Errorf("нет pid приложения")
	}
	return windows.OpenProcess(windows.SYNCHRONIZE, false, pid)
}

func processAlive(pid uint32) bool {
	h, err := openForWait(pid)
	if err != nil {
		return false
	}
	defer windows.CloseHandle(h)
	// Signalled means exited; a timeout means it is still running.
	event, err := windows.WaitForSingleObject(h, 0)
	return err == nil && event == uint32(windows.WAIT_TIMEOUT)
}

// awaitExit blocks until the process exits. A handle keeps pointing at the process it was opened for, so
// a reused pid cannot mislead it; a pid that cannot be opened at all belongs to a process already gone.
func awaitExit(pid uint32) error {
	h, err := openForWait(pid)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(h)
	_, err = windows.WaitForSingleObject(h, windows.INFINITE)
	return err
}
