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
	if len(req.Dns) > 0 {
		dns, err := joinAddrs(req.Dns)
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
