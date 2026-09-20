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
	dir = strings.ToLower(filepath.Clean(dir)) + `\`
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return
	}
	defer windows.CloseHandle(snap)

	var pe windows.ProcessEntry32
	pe.Size = uint32(unsafe.Sizeof(pe))
	killed := false
	for err = windows.Process32First(snap, &pe); err == nil; err = windows.Process32Next(snap, &pe) {
		if int(pe.ProcessID) == os.Getpid() {
			continue
		}
		h, oerr := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.PROCESS_TERMINATE, false, pe.ProcessID)
		if oerr != nil {
			continue
		}
		buf := make([]uint16, windows.MAX_LONG_PATH)
		n := uint32(len(buf))
		if windows.QueryFullProcessImageName(h, 0, &buf[0], &n) == nil &&
			strings.HasPrefix(strings.ToLower(windows.UTF16ToString(buf[:n])), dir) {
			if windows.TerminateProcess(h, 1) == nil {
				killed = true
			}
		}
		windows.CloseHandle(h)
	}
	if killed {
		// Let the system release the files the dead processes held.
		time.Sleep(500 * time.Millisecond)
	}
}
