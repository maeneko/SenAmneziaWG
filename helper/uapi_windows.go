package main

import (
	"bufio"
	"errors"
	"strings"
	"time"

	"github.com/amnezia-vpn/amneziawg-go/v3/ipc/namedpipe"
	"github.com/amnezia-vpn/amneziawg-windows/v3/services"
)

// uapiRequest is one round trip to the running tunnel's UAPI pipe. That pipe admits only SYSTEM and
// Administrators, which is why the app asks this service instead of connecting itself.
func uapiRequest(body string, timeout time.Duration) (string, error) {
	path, err := services.PipePathOfTunnel(tunnelName)
	if err != nil {
		return "", err
	}
	conn, err := namedpipe.DialTimeout(path, timeout)
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
