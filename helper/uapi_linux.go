//go:build linux

package main

import (
	"bufio"
	"errors"
	"net"
	"strings"
	"time"
)

// daemonSocket is where amneziawg-go's own UAPI listens for the interface this helper manages —
// ipc/uapi_unix.go's own convention, the same directory macOS's amneziawg-go uses (uapi.ts:UAPI_DIR).
func daemonSocket(iface string) string { return "/var/run/amneziawg/" + iface + ".sock" }

// uapiRequest is one round trip to the daemon's own UAPI socket. Only this process (root) ever dials
// it: the app reaches the tunnel through the helper's own socket instead (socket_linux.go), which is
// what lets a per-request identity check (SO_PEERCRED) sit in front of it.
func uapiRequest(iface, body string, timeout time.Duration) (string, error) {
	conn, err := net.DialTimeout("unix", daemonSocket(iface), timeout)
	if err != nil {
		return "", err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(timeout))
	if _, err := conn.Write([]byte(body)); err != nil {
		return "", err
	}

	var out strings.Builder
	r := bufio.NewReader(conn)
	for {
		line, err := r.ReadString('\n')
		out.WriteString(line)
		if strings.HasPrefix(line, "errno=") {
			return out.String(), nil
		}
		if err != nil {
			return out.String(), errors.New("нет ответа от туннеля")
		}
	}
}
