package main

import (
	"bufio"
	"fmt"
	"net"
	"runtime/debug"
	"time"

	"github.com/amnezia-vpn/amneziawg-go/v3/ipc/namedpipe"
	"golang.org/x/sys/windows"

	"amnesiawg-helper/internal/proto"
)

// SYSTEM and Administrators may do anything; any interactively logged-on user may read and write, so
// the unelevated app can talk to the service. 0x12019b is FILE_GENERIC_READ|WRITE|SYNCHRONIZE without
// FILE_CREATE_PIPE_INSTANCE (0x4, the same bit as FILE_APPEND_DATA): nobody but the service can add an
// instance to the pipe and impersonate it. Remote clients are refused by the pipe itself.
const pipeSDDL = "O:SYG:SYD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;0x12019b;;;IU)"

func listenPipe() (net.Listener, error) {
	sd, err := windows.SecurityDescriptorFromString(pipeSDDL)
	if err != nil {
		return nil, err
	}
	cfg := namedpipe.ListenConfig{SecurityDescriptor: sd}
	return cfg.Listen(helperPipe)
}

func serve(c *controller, l net.Listener) {
	for {
		conn, err := l.Accept()
		if err != nil {
			return // closed on shutdown
		}
		go handle(c, conn)
	}
}

func handle(c *controller, conn net.Conn) {
	defer conn.Close()
	// Reading the request is short; acting on it (starting a service) is not.
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	req, err := proto.ReadRequest(bufio.NewReaderSize(conn, 4096))
	if err != nil {
		_ = proto.WriteResponse(conn, &proto.Response{Code: proto.CodeBadRequest, Error: "Некорректный запрос к службе AmnesiaWG"})
		return
	}
	_ = conn.SetDeadline(time.Time{})
	resp := dispatch(c, req)
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	_ = proto.WriteResponse(conn, resp)
}

func dispatch(c *controller, req *proto.Request) (resp *proto.Response) {
	// A bug in one request must not take the service, and with it the tunnel, down.
	defer func() {
		if r := recover(); r != nil {
			resp = proto.Fail(fmt.Errorf("паника: %v\n%s", r, debug.Stack()))
		}
	}()

	if req.Op == proto.OpHello {
		return &proto.Response{OK: true, Protocol: proto.Version, Helper: version, AwgGo: awgGoVersion()}
	}
	if req.V != proto.Version {
		return &proto.Response{Code: proto.CodeBadRequest, Error: "Служба AmnesiaWG и приложение разной версии — переустановите AmnesiaWG"}
	}

	var (
		out *proto.Response
		err error
	)
	switch req.Op {
	case proto.OpUp:
		out, err = c.up(req)
	case proto.OpDown:
		out, err = c.down()
	case proto.OpStatus:
		out, err = c.status(req)
	case proto.OpStats:
		out, err = c.stats()
	case proto.OpNetinfo:
		out, err = netInfo(req.Target)
	case proto.OpCleanup:
		out, err = c.cleanup()
	default:
		err = proto.Errf(proto.CodeBadRequest, "Неизвестная операция")
	}
	if err != nil {
		return proto.Fail(err)
	}
	return out
}
