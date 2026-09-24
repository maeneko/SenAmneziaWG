// dispatch.go holds what pipe_windows.go and socket_linux.go share: decoding one request, watching the
// app that sent it, and routing it to the platform's controller. It imports nothing platform-specific,
// so it is built and tested everywhere (like internal/proto, which it depends on).
package main

import (
	"fmt"
	"runtime/debug"

	"senawg-helper/internal/proto"
)

// Set at build time: -ldflags "-X main.version=...".
var version = "dev"

// engine is what dispatch needs from the platform's tunnel controller. tunnel_windows.go's controller
// and tunnel_linux.go's controller both implement it.
type engine interface {
	up(req *proto.Request) (*proto.Response, error)
	down() (*proto.Response, error)
	status() (*proto.Response, error)
	stats() (*proto.Response, error)
	cleanup() (*proto.Response, error)
	// watch arms the lifetime watcher on the app that sent the request (or does nothing for pid 0 or a
	// pid already being watched — see internal/lifetime).
	watch(pid uint32)
}

// keyStore is what an engine that keeps tunnel keys itself adds (tunnel_linux.go, with internal/vault).
// Windows has none: there the app's safeStorage is DPAPI, always available.
type keyStore interface {
	secretPut(req *proto.Request) (*proto.Response, error)
	secretDelete(req *proto.Request) (*proto.Response, error)
}

// netInfoFunc answers OpNetinfo. Each platform sets it from an init() in its own netinfo_*.go, because
// the answer needs OS-specific route and resolver lookups.
var netInfoFunc func(target string) (*proto.Response, error)

// dispatch is the one place a request becomes a response, for every op and on every platform.
func dispatch(e engine, req *proto.Request) (resp *proto.Response) {
	// A bug in one request must not take the service, and with it the tunnel, down.
	defer func() {
		if r := recover(); r != nil {
			resp = proto.Fail(fmt.Errorf("паника: %v\n%s", r, debug.Stack()))
		}
	}()

	// Whoever talks to the service is the app it lives for, from `hello` on.
	e.watch(req.PID)

	if req.Op == proto.OpHello {
		return &proto.Response{OK: true, Protocol: proto.Version, Helper: version, AwgGo: awgGoVersion()}
	}
	if req.V != proto.Version {
		return &proto.Response{Code: proto.CodeBadRequest, Error: "Служба SenAWG и приложение разной версии — переустановите SenAWG"}
	}

	var (
		out *proto.Response
		err error
	)
	switch req.Op {
	case proto.OpUp:
		out, err = e.up(req)
	case proto.OpDown:
		out, err = e.down()
	case proto.OpStatus:
		out, err = e.status()
	case proto.OpStats:
		out, err = e.stats()
	case proto.OpNetinfo:
		out, err = netInfoFunc(req.Target)
	case proto.OpCleanup:
		out, err = e.cleanup()
	case proto.OpSecretPut, proto.OpSecretDelete:
		ks, ok := e.(keyStore)
		switch {
		case !ok:
			err = proto.Errf(proto.CodeBadRequest, "Неизвестная операция")
		case req.Op == proto.OpSecretPut:
			out, err = ks.secretPut(req)
		default:
			out, err = ks.secretDelete(req)
		}
	default:
		err = proto.Errf(proto.CodeBadRequest, "Неизвестная операция")
	}
	if err != nil {
		return proto.Fail(err)
	}
	return out
}

// depVersion reads a build dependency's resolved version, e.g. "v3.1.20260828" for amneziawg-go — shown
// in «Об SenAWG» and compared against what a config needs, same as macOS does with its bundled binary.
func depVersion(path string) string {
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, dep := range info.Deps {
			if dep.Path == path {
				if dep.Replace != nil {
					return dep.Replace.Version
				}
				return dep.Version
			}
		}
	}
	return "unknown"
}

// awgGoVersion is the daemon compiled into this executable, e.g. "v3.1.20260828".
func awgGoVersion() string { return depVersion("github.com/amnezia-vpn/amneziawg-go/v3") }
