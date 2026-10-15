package splitdns

import (
	"net/netip"
	"strings"
)

// ParseResolvConf reads the `nameserver` lines of a resolv.conf: the system's own DNS servers, the
// ones the direct side of the proxy asks. Loopback and unspecified entries are dropped (a local stub
// such as systemd-resolved's 127.0.0.53 would hand the question straight back to this proxy once the
// system's resolver points at it), and so are IPv6 link-local ones, which cannot be dialled without
// knowing the link.
func ParseResolvConf(text string) []netip.Addr {
	var out []netip.Addr
	seen := map[netip.Addr]bool{}
	for _, line := range strings.Split(text, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 || fields[0] != "nameserver" {
			continue
		}
		ip, err := netip.ParseAddr(fields[1])
		if err != nil {
			continue
		}
		ip = ip.Unmap()
		if ip.IsLoopback() || ip.IsUnspecified() || ip.IsLinkLocalUnicast() || ip.IsMulticast() || seen[ip] {
			continue
		}
		seen[ip] = true
		out = append(out, ip)
	}
	return out
}

// ParseAddrs turns the request's DNS list into addresses, skipping what does not parse.
func ParseAddrs(list []string) []netip.Addr {
	var out []netip.Addr
	for _, s := range list {
		if ip, err := netip.ParseAddr(s); err == nil {
			out = append(out, ip.Unmap())
		}
	}
	return out
}
