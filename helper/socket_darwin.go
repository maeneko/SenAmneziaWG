//go:build darwin

package main

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/unix"

	"senawg-helper/internal/proto"
)

// listenSocket takes the socket launchd opened for the service (launchd_darwin.go). Only when the
// service was not started by launchd at all (ESRCH: run by hand while developing) does it open one
// itself, and then owned tells runService to remove it on the way out.
func listenSocket() (l net.Listener, owned bool, err error) {
	l, err = launchdListener(launchdSocketKey)
	if err == nil {
		return l, false, nil
	}
	if !errors.Is(err, syscall.ESRCH) {
		return nil, false, fmt.Errorf("сокет от launchd: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(socketPath), 0o755); err != nil {
		return nil, false, err
	}
	_ = os.Remove(socketPath)
	l, err = net.Listen("unix", socketPath)
	if err != nil {
		return nil, false, err
	}
	if err := os.Chmod(socketPath, 0o666); err != nil {
		l.Close()
		return nil, false, err
	}
	return l, true, nil
}

// peerOf asks the kernel who holds the other end: LOCAL_PEERCRED for the uid, LOCAL_PEERPID for the pid.
func peerOf(conn *net.UnixConn) (peer, error) {
	raw, err := conn.SyscallConn()
	if err != nil {
		return peer{}, err
	}
	var (
		cred *unix.Xucred
		pid  int
		cerr error
	)
	err = raw.Control(func(fd uintptr) {
		if cred, cerr = unix.GetsockoptXucred(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERCRED); cerr != nil {
			return
		}
		pid, cerr = unix.GetsockoptInt(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERPID)
	})
	if err != nil {
		return peer{}, err
	}
	if cerr != nil {
		return peer{}, cerr
	}
	return peer{pid: uint32(pid), uid: cred.Uid}, nil
}

// refusePeer answers only root and the user at the screen, the owner of /dev/console: the tunnel and
// the DNS it sets are the whole Mac's, so another account logged in over ssh or in the background of
// fast user switching must not switch them on or off.
func refusePeer(p peer) *proto.Error {
	if p.uid == 0 {
		return nil
	}
	var st unix.Stat_t
	if err := unix.Stat("/dev/console", &st); err == nil && st.Uid == p.uid {
		return nil
	}
	return proto.Errf(proto.CodeNoAccess, "VPN SenAWG управляет пользователь, который сейчас работает за этим Mac")
}
