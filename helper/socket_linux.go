//go:build linux

package main

import (
	"net"
	"os"

	"golang.org/x/sys/unix"

	"senawg-helper/internal/proto"
)

// listenSocket opens the Unix socket the app talks to. 0666 mirrors the Windows pipe's IU right: any
// local user may connect; what they may ask for is bounded by ValidateUpUAPI, and who they claim to be
// (the pid the tunnel is tied to) is never trusted from the request — see peerOf below.
func listenSocket(path string) (net.Listener, error) {
	if err := os.MkdirAll(layout().run, 0o755); err != nil {
		return nil, err
	}
	_ = os.Remove(path) // a socket left by a service that did not shut down cleanly
	l, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0o666); err != nil {
		l.Close()
		return nil, err
	}
	return l, nil
}

// peerOf reads SO_PEERCRED off the connection: the pid and uid, verified by the kernel, of whoever
// holds the other end of this one connection.
func peerOf(conn *net.UnixConn) (peer, error) {
	raw, err := conn.SyscallConn()
	if err != nil {
		return peer{}, err
	}
	var cred *unix.Ucred
	var cerr error
	err = raw.Control(func(fd uintptr) {
		cred, cerr = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
	})
	if err != nil {
		return peer{}, err
	}
	if cerr != nil {
		return peer{}, cerr
	}
	return peer{pid: uint32(cred.Pid), uid: cred.Uid}, nil
}

// refusePeer: on Linux every local user may use the service (its keys are kept per user, vault.go).
func refusePeer(peer) *proto.Error { return nil }
