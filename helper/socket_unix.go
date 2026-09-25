//go:build linux || darwin

package main

import (
	"bufio"
	"net"
	"time"

	"senawg-helper/internal/proto"
)

// peer is who holds the other end of one connection, as the kernel says (socket_linux.go and
// socket_darwin.go each ask it their own way).
type peer struct{ pid, uid uint32 }

func serve(c engine, l net.Listener) {
	for {
		conn, err := l.Accept()
		if err != nil {
			return // closed on shutdown
		}
		go handle(c, conn.(*net.UnixConn))
	}
}

func handle(c engine, conn *net.UnixConn) {
	defer conn.Close()
	p, err := peerOf(conn)
	if err != nil {
		return // the kernel would not say who is on the other end; nothing to do for them
	}
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	req, err := proto.ReadRequest(bufio.NewReaderSize(conn, 4096))
	if err != nil {
		_ = proto.WriteResponse(conn, &proto.Response{Code: proto.CodeBadRequest, Error: "Некорректный запрос к службе SenAWG"})
		return
	}
	if refused := refusePeer(p); refused != nil {
		_ = proto.WriteResponse(conn, proto.Fail(refused))
		return
	}
	// The kernel's own idea of who is connected, not the client's claim: a request cannot arm the
	// lifetime watcher on a pid it does not actually hold the socket from.
	req.PID = p.pid
	// Likewise the user whose keys a secret-put/secret-delete/up touches (internal/vault), and on macOS
	// the one awg.sh hands the tunnel's UAPI socket to.
	req.UID, req.UIDKnown = p.uid, true
	_ = conn.SetDeadline(time.Time{})
	resp := dispatch(c, req)
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	_ = proto.WriteResponse(conn, resp)
}
