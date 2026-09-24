//go:build linux

package main

import (
	"bufio"
	"net"
	"os"
	"time"

	"golang.org/x/sys/unix"

	"senawg-helper/internal/proto"
)

// listenSocket opens the Unix socket the app talks to. 0666 mirrors the Windows pipe's IU right: any
// local user may connect; what they may ask for is bounded by ValidateUpUAPI, and who they claim to be
// (the pid the tunnel is tied to) is never trusted from the request — see peerCred below.
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

func serve(c *controller, l net.Listener) {
	for {
		conn, err := l.Accept()
		if err != nil {
			return // closed on shutdown
		}
		go handle(c, conn.(*net.UnixConn))
	}
}

func handle(c *controller, conn *net.UnixConn) {
	defer conn.Close()
	cred, err := peerCred(conn)
	if err != nil {
		return // the kernel would not say who is on the other end; nothing to do for them
	}
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	req, err := proto.ReadRequest(bufio.NewReaderSize(conn, 4096))
	if err != nil {
		_ = proto.WriteResponse(conn, &proto.Response{Code: proto.CodeBadRequest, Error: "Некорректный запрос к службе SenAWG"})
		return
	}
	// The kernel's own idea of who is connected, not the client's claim: a request cannot arm the
	// lifetime watcher on a pid it does not actually hold the socket from.
	req.PID = uint32(cred.Pid)
	// Likewise the user whose keys a secret-put/secret-delete/up touches (internal/vault).
	req.UID, req.UIDKnown = cred.Uid, true
	_ = conn.SetDeadline(time.Time{})
	resp := dispatch(c, req)
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	_ = proto.WriteResponse(conn, resp)
}

// peerCred reads SO_PEERCRED off the connection: the pid and uid, verified by the kernel, of whoever
// holds the other end of this one connection.
func peerCred(conn *net.UnixConn) (*unix.Ucred, error) {
	raw, err := conn.SyscallConn()
	if err != nil {
		return nil, err
	}
	var cred *unix.Ucred
	var cerr error
	err = raw.Control(func(fd uintptr) {
		cred, cerr = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
	})
	if err != nil {
		return nil, err
	}
	if cerr != nil {
		return nil, cerr
	}
	return cred, nil
}
