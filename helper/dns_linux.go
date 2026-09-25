//go:build linux

package main

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// dnsMethod records which of the three ways below actually took, so cleanup can undo exactly that one
// (mirrors awg.sh's DNS_SERVICE/DNS_OLD state for the same reason).
type dnsMethod string

const (
	dnsNone       dnsMethod = ""
	dnsResolved   dnsMethod = "resolved"   // resolvectl (systemd-resolved)
	dnsResolvconf dnsMethod = "resolvconf" // openresolv or Debian resolvconf
	dnsFile       dnsMethod = "file"       // /etc/resolv.conf, rewritten directly
)

type dnsState struct {
	Method dnsMethod `json:"method,omitempty"`
	Iface  string    `json:"iface,omitempty"`
}

// setDNS tries resolvectl, then resolvconf, then a direct rewrite of /etc/resolv.conf — the same order
// the plan settled on, widest compatibility first is not the point; correctness (a real, working
// resolver setup) is, and resolvectl is both the most common today and the easiest to revert cleanly.
func setDNS(d dirs, iface string, servers []string) dnsState {
	if len(servers) == 0 {
		svcInfo("DNS: не задан, системный DNS не трогаю")
		return dnsState{}
	}
	if path, err := exec.LookPath("resolvectl"); err == nil {
		err := setDNSResolved(path, iface, servers)
		if err == nil {
			svcInfo("DNS: %v через resolvectl (systemd-resolved) на %s", servers, iface)
			return dnsState{Method: dnsResolved, Iface: iface}
		}
		svcWarn("DNS: resolvectl не сработал: %v", err)
	} else {
		svcInfo("DNS: resolvectl не найден")
	}
	if path, err := exec.LookPath("resolvconf"); err == nil {
		err := setDNSResolvconf(path, iface, servers)
		if err == nil {
			svcInfo("DNS: %v через resolvconf (%s)", servers, path)
			return dnsState{Method: dnsResolvconf, Iface: iface}
		}
		svcWarn("DNS: resolvconf не сработал: %v", err)
	} else {
		svcInfo("DNS: resolvconf не найден")
	}
	if err := setDNSFile(d, servers); err != nil {
		svcError("DNS: не удалось записать /etc/resolv.conf: %v — DNS туннеля не установлен", err)
		return dnsState{}
	}
	svcInfo("DNS: %v записаны прямо в /etc/resolv.conf (старый сохранён)", servers)
	return dnsState{Method: dnsFile}
}

func dnsLabel(m dnsMethod) string {
	if m == dnsNone {
		return "не менялся"
	}
	return string(m)
}

func setDNSResolved(bin, iface string, servers []string) error {
	if err := run(bin, append([]string{"dns", iface}, servers...)...); err != nil {
		return err
	}
	// ~. : this tunnel's resolver is asked for every name, not only names under some domain.
	if err := run(bin, "domain", iface, "~."); err != nil {
		return err
	}
	return run(bin, "default-route", iface, "yes")
}

func setDNSResolvconf(bin, iface string, servers []string) error {
	cmd := exec.Command(bin, "-a", iface, "-m", "0", "-x")
	cmd.Stdin = strings.NewReader(nameserverLines(servers))
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func setDNSFile(d dirs, servers []string) error {
	cur, err := os.ReadFile("/etc/resolv.conf")
	if err == nil {
		_ = os.WriteFile(d.resolvBak(), cur, 0o600)
	}
	return os.WriteFile("/etc/resolv.conf", []byte(nameserverLines(servers)), 0o644)
}

func nameserverLines(servers []string) string {
	var b strings.Builder
	for _, s := range servers {
		fmt.Fprintf(&b, "nameserver %s\n", s)
	}
	return b.String()
}

// restoreDNS undoes exactly what setDNS did, best effort (a missing tool or file at this point means
// there is nothing left to undo, not a failure worth reporting).
func restoreDNS(d dirs, st dnsState) {
	switch st.Method {
	case dnsResolved:
		if path, err := exec.LookPath("resolvectl"); err == nil {
			_ = run(path, "revert", st.Iface)
		}
	case dnsResolvconf:
		if path, err := exec.LookPath("resolvconf"); err == nil {
			_ = run(path, "-d", st.Iface)
		}
	case dnsFile:
		if b, err := os.ReadFile(d.resolvBak()); err == nil {
			_ = os.WriteFile("/etc/resolv.conf", b, 0o644)
			_ = os.Remove(d.resolvBak())
		}
	}
}

func run(bin string, args ...string) error {
	cmd := exec.Command(bin, args...)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("%s %s: %w: %s", bin, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}
