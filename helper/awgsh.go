// awgsh.go is the pure-string side of the macOS service (tunnel_darwin.go): turning a request into
// awg.sh's arguments and reading back what awg.sh writes. No build tag, so it is tested everywhere.
package main

import (
	"errors"
	"fmt"
	"net/netip"
	"strconv"
	"strings"

	"senawg-helper/internal/proto"
)

// splitListenAddr is where the DNS proxy of «Что идёт через VPN» answers (split_darwin.go adds it to lo0).
const splitListenAddr = "127.77.0.1"

// defaultMTU is awg.sh's own default, used when a request leaves Mtu out.
const defaultMTU = 1280

// awgShUpArgs builds `awg.sh up`'s arguments. The request has passed proto.ValidateUpUAPI already;
// every list is still parsed again here and rebuilt from the parsed values, so nothing but addresses
// ever reaches a root shell script. What makes a request dangerous is not taken from it at all: the
// daemon (bin) is the service's own copy, and the uid and pid come from the kernel (peerOf), not JSON.
func awgShUpArgs(req *proto.Request, bin, body, appCmd string) ([]string, error) {
	if !req.UIDKnown || req.PID == 0 {
		return nil, errors.New("не удалось определить, кто запросил туннель")
	}
	ep, err := netip.ParseAddr(endpointOf(req.Conf))
	if err != nil {
		return nil, errors.New("в конфигурации нет IP-адреса сервера")
	}
	address, err := joinPrefixes(req.Address)
	if err != nil {
		return nil, fmt.Errorf("некорректный адрес туннеля: %w", err)
	}
	allowed, err := joinPrefixes(allowedIPsOf(req.Conf))
	if err != nil || allowed == "" {
		return nil, errors.New("некорректный AllowedIPs")
	}
	mtu := req.Mtu
	if mtu == 0 {
		mtu = defaultMTU
	}

	args := []string{
		"up",
		"--id", req.ID,
		"--uid", strconv.FormatUint(uint64(req.UID), 10),
		"--bin", bin,
		"--body", body,
		"--endpoint-ip", ep.Unmap().String(),
		"--address", address,
		"--allowed", allowed,
		"--mtu", strconv.Itoa(mtu),
		// awg.sh's monitor takes the tunnel down the moment this process is gone (quit, crash or Force
		// Quit); the name guards against the pid being reused by something else meanwhile.
		"--app-pid", strconv.FormatUint(uint64(req.PID), 10),
	}
	if appCmd != "" {
		args = append(args, "--app-cmd", appCmd)
	}
	dnsServers := req.Dns
	if req.Routing != nil {
		// The system asks the service's DNS proxy; it is the one that knows the tunnel's DNS (req.Dns).
		dnsServers = []string{splitListenAddr}
		if req.Routing.Final == proto.FinalDirect {
			// Nothing goes into the tunnel by default: no 0/1 (the service routes what the rules send in).
			args = append(args, "--split", "include")
		}
	}
	if len(dnsServers) > 0 {
		dns, err := joinAddrs(dnsServers)
		if err != nil {
			return nil, fmt.Errorf("некорректный DNS-сервер: %w", err)
		}
		args = append(args, "--dns", dns)
	}
	if req.Diagnostics {
		args = append(args, "--diagnostics", "1")
	}
	if req.Replace {
		args = append(args, "--replace", "1")
	}
	return args, nil
}

// splitList flattens entries that may themselves be comma lists ("10.0.0.2/32, fd00::2/128").
func splitList(entries []string) []string {
	var out []string
	for _, e := range entries {
		for _, item := range strings.Split(e, ",") {
			if item = strings.TrimSpace(item); item != "" {
				out = append(out, item)
			}
		}
	}
	return out
}

// joinPrefixes accepts CIDRs and bare addresses (a single host), as a .conf does.
func joinPrefixes(entries []string) (string, error) {
	var out []string
	for _, item := range splitList(entries) {
		if strings.Contains(item, "/") {
			p, err := netip.ParsePrefix(item)
			if err != nil {
				return "", fmt.Errorf("%q не сеть в формате CIDR", item)
			}
			out = append(out, p.String())
			continue
		}
		a, err := netip.ParseAddr(item)
		if err != nil {
			return "", fmt.Errorf("%q не IP-адрес", item)
		}
		out = append(out, a.String())
	}
	return strings.Join(out, ","), nil
}

func joinAddrs(entries []string) (string, error) {
	var out []string
	for _, item := range splitList(entries) {
		a, err := netip.ParseAddr(item)
		if err != nil {
			return "", fmt.Errorf("%q не IP-адрес", item)
		}
		out = append(out, a.String())
	}
	return strings.Join(out, ","), nil
}

// parseStateEnv reads the fields of awg.sh's state.env that the service needs. awg.sh writes each with
// printf %q; the ones read here are ids, interface names and numbers, which %q leaves as they are.
func parseStateEnv(text string) map[string]string {
	out := map[string]string{}
	for _, line := range strings.Split(text, "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok || value == "" || strings.ContainsAny(value, " \t'\"\\$") {
			continue
		}
		switch key {
		case "ID", "IFACE", "PID", "MONITOR_PID":
			out[key] = value
		}
	}
	return out
}

// splitScriptOutput separates awg.sh's `warning:` lines from the rest, which is the error message when
// the script failed (src/main/tunnel/helperOutput.ts did the same with osascript's output). `IFACE=` is
// a machine line, not for people.
func splitScriptOutput(text string) (warnings []string, rest string) {
	var other []string
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "IFACE=") {
			continue
		}
		if w, ok := strings.CutPrefix(line, "warning:"); ok {
			warnings = append(warnings, strings.TrimSpace(w))
		} else {
			other = append(other, line)
		}
	}
	return warnings, strings.Join(other, "\n")
}

// parseAwgGoVersion reads `amneziawg-go --version`'s first line: "amneziawg-go v3.1.20260828" → the
// version alone, the same thing the Linux service reports from build info.
func parseAwgGoVersion(out string) string {
	first, _, _ := strings.Cut(out, "\n")
	if v, ok := strings.CutPrefix(strings.TrimSpace(first), "amneziawg-go "); ok && v != "" {
		return v
	}
	return "unknown"
}

// parseScutilDNS reads `scutil --dns`: the nameservers of the system's ordinary resolvers (the first
// section; resolvers for one domain or for mDNS are not the system's DNS). Loopback entries are dropped:
// that is this service's own proxy, after a crash, or a local stub that would send the question back.
func parseScutilDNS(text string) []netip.Addr {
	var out []netip.Addr
	seen := map[netip.Addr]bool{}
	flush := func(servers []netip.Addr, special bool) {
		if special {
			return
		}
		for _, ip := range servers {
			if !seen[ip] {
				seen[ip] = true
				out = append(out, ip)
			}
		}
	}
	var servers []netip.Addr
	special := false
	for _, line := range strings.Split(text, "\n") {
		trimmed := strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(trimmed, "DNS configuration (for scoped queries)"):
			flush(servers, special)
			return out
		case strings.HasPrefix(trimmed, "resolver #"):
			flush(servers, special)
			servers, special = nil, false
		case strings.HasPrefix(trimmed, "domain ") || strings.HasPrefix(trimmed, "options ") && strings.Contains(trimmed, "mdns"):
			special = true
		case strings.HasPrefix(trimmed, "nameserver["):
			_, v, ok := strings.Cut(trimmed, ":")
			if !ok {
				continue
			}
			ip, err := netip.ParseAddr(strings.TrimSpace(v))
			if err != nil {
				continue
			}
			ip = ip.Unmap()
			if ip.IsLoopback() || ip.IsUnspecified() || ip.IsLinkLocalUnicast() || ip.IsMulticast() {
				continue
			}
			servers = append(servers, ip)
		}
	}
	flush(servers, special)
	return out
}

// parseNetstatDefault finds the physical default route in `netstat -nr -f inet|inet6`: the first
// `default` whose gateway is a real address and whose interface is not a tunnel (ours, another VPN's,
// or macOS's own utun/ipsec) — the same choice as awg.sh's physical_default.
func parseNetstatDefault(text string) (gateway, iface string) {
	for _, line := range strings.Split(text, "\n") {
		f := strings.Fields(line)
		if len(f) < 4 || f[0] != "default" || strings.HasPrefix(f[1], "link#") {
			continue
		}
		if strings.HasPrefix(f[3], "utun") || strings.HasPrefix(f[3], "ipsec") {
			continue
		}
		return f[1], f[3]
	}
	return "", ""
}
