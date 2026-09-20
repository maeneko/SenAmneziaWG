package main

import (
	"fmt"

	"golang.org/x/sys/windows"
)

// The tunnel is a Windows service: it has no parent process and nothing ties it to the app that asked
// for it. So the app's lifetime has to be watched explicitly, or a tunnel would outlive the app that
// owns it — including when the app is killed from Task Manager.

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

// watchApp blocks until the app exits, then stops the tunnel — unless that tunnel has since been
// replaced or stopped, which `gen` tells us. A handle keeps pointing at the process it was opened for,
// so a reused pid cannot mislead it.
func (c *controller) watchApp(pid uint32, gen uint64) {
	h, err := openForWait(pid)
	if err != nil {
		c.mirror.Note(fmt.Sprintf("не удалось следить за приложением (pid %d): %v", pid, err))
		return
	}
	defer windows.CloseHandle(h)
	if _, err := windows.WaitForSingleObject(h, windows.INFINITE); err != nil {
		return
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	if c.gen != gen {
		return // this tunnel was already replaced or stopped
	}
	c.mirror.Note("приложение закрыто — останавливаю туннель")
	c.teardownLocked()
}

// watchLocked points the watcher at `pid`. Every call invalidates the previous watcher through `gen`.
func (c *controller) watchLocked(pid uint32) {
	c.gen++
	go c.watchApp(pid, c.gen)
}
