//go:build darwin && cgo

package main

/*
#include <launch.h>
#include <stdlib.h>
*/
import "C"

import (
	"errors"
	"net"
	"os"
	"syscall"
	"unsafe"
)

// launchdListener takes the socket named in the job's plist (Sockets → name). launchd opens it before
// the service runs, which is what lets the service start on demand: the app just connects. ESRCH means
// this process was not started by launchd.
func launchdListener(name string) (net.Listener, error) {
	cname := C.CString(name)
	defer C.free(unsafe.Pointer(cname))
	var (
		fds *C.int
		n   C.size_t
	)
	if rc := C.launch_activate_socket(cname, &fds, &n); rc != 0 {
		return nil, syscall.Errno(rc)
	}
	defer C.free(unsafe.Pointer(fds))
	all := unsafe.Slice(fds, int(n))
	if len(all) == 0 {
		return nil, errors.New("launchd не передал ни одного сокета")
	}
	// The plist declares one socket (a path); anything more is closed, not leaked.
	for _, fd := range all[1:] {
		_ = syscall.Close(int(fd))
	}
	f := os.NewFile(uintptr(all[0]), name)
	defer f.Close() // FileListener dups it
	return net.FileListener(f)
}
