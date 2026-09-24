//go:build linux

package main

import (
	"bufio"
	"net"
	"net/netip"
	"os"
	"strings"

	"senawg-helper/internal/proto"
)

func init() { netInfoFunc = netInfo }

// netInfo answers the app's connectivity check: which interface a packet to target would leave from,
// and which resolver /etc/resolv.conf currently names — whatever put it there (resolvectl, resolvconf,
// or our own fallback rewrite all end up producing that file, directly or through systemd's stub).
func netInfo(target string) (*proto.Response, error) {
	ip, err := netip.ParseAddr(target)
	if err != nil {
		return nil, proto.Errf(proto.CodeBadRequest, "Для проверки маршрута нужен IP-адрес")
	}
	resp := &proto.Response{OK: true}
	if iface, err := routeInterfaceFor(net.IP(ip.AsSlice())); err == nil {
		resp.RouteIface = iface
	}
	if servers := readResolvConf(); len(servers) > 0 {
		resp.Resolver = &proto.Resolver{Nameservers: servers}
	}
	return resp, nil
}

func readResolvConf() []string {
	f, err := os.Open("/etc/resolv.conf")
	if err != nil {
		return nil
	}
	defer f.Close()
	var out []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) == 2 && fields[0] == "nameserver" {
			out = append(out, fields[1])
		}
	}
	return out
}
