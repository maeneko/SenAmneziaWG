package main

import (
	"os"
	"path/filepath"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// killProcessesUnder ends every process whose executable lives under dir. An update cannot replace the
// files of an application that is running, and a running application cannot be asked politely from an
// elevated helper: the tunnel goes down with it either way (the service watches the app's pid).
// It never touches this process.
func killProcessesUnder(dir string) {
	killed := false
	eachProcessUnder(dir, windows.PROCESS_TERMINATE, func(h windows.Handle) bool {
		if windows.TerminateProcess(h, 1) == nil {
			killed = true
		}
		return true
	})
	if killed {
		// Let the system release the files the dead processes held.
		time.Sleep(500 * time.Millisecond)
	}
}

// anyProcessUnder reports whether a process is still running from dir.
func anyProcessUnder(dir string) bool {
	found := false
	eachProcessUnder(dir, 0, func(windows.Handle) bool {
		found = true
		return false
	})
	return found
}

// waitUntilNoProcessUnder blocks until nothing runs from dir: the removal screen stays up until the
// user presses «Завершить», and the application's folder can only go after that.
func waitUntilNoProcessUnder(dir string) {
	for anyProcessUnder(dir) {
		time.Sleep(500 * time.Millisecond)
	}
}

// eachProcessUnder calls fn with a handle (query access plus `access`) to every process, other than
// this one, whose executable lives under dir, until fn returns false.
func eachProcessUnder(dir string, access uint32, fn func(windows.Handle) bool) {
	dir = strings.ToLower(filepath.Clean(dir)) + `\`
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return
	}
	defer windows.CloseHandle(snap)

	var pe windows.ProcessEntry32
	pe.Size = uint32(unsafe.Sizeof(pe))
	for err = windows.Process32First(snap, &pe); err == nil; err = windows.Process32Next(snap, &pe) {
		if int(pe.ProcessID) == os.Getpid() {
			continue
		}
		h, oerr := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|access, false, pe.ProcessID)
		if oerr != nil {
			continue
		}
		buf := make([]uint16, windows.MAX_LONG_PATH)
		n := uint32(len(buf))
		match := windows.QueryFullProcessImageName(h, 0, &buf[0], &n) == nil &&
			strings.HasPrefix(strings.ToLower(windows.UTF16ToString(buf[:n])), dir)
		more := true
		if match {
			more = fn(h)
		}
		windows.CloseHandle(h)
		if !more {
			return
		}
	}
}
