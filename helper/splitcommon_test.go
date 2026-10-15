package main

import (
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"senawg-helper/internal/proto"
)

const winConf = "[Interface]\nPrivateKey = aaa\nAddress = 10.8.1.2/32, fd00::2/128\nDNS = 10.8.1.1, 1.1.1.1\nMTU = 1280\n\n[Peer]\nPublicKey = bbb\nAllowedIPs = 0.0.0.0/0, ::/0\nEndpoint = 203.0.113.5:51820\n"

func TestSplitConf(t *testing.T) {
	got := splitConf(winConf)
	if strings.Count(got, "DNS =") != 1 || !strings.Contains(got, "DNS = "+splitListenAddr) || strings.Contains(got, "10.8.1.1") {
		t.Fatalf("DNS not replaced:\n%s", got)
	}
	if strings.Count(strings.ToLower(got), "table = off") != 1 {
		t.Fatalf("Table = off missing:\n%s", got)
	}
	// Both lines sit in [Interface], before [Peer].
	if strings.Index(got, "Table = off") > strings.Index(got, "[Peer]") || strings.Index(got, "Table = off") < strings.Index(got, "[Interface]") {
		t.Fatalf("keys outside [Interface]:\n%s", got)
	}
	// Whatever the request tried to say about Table is replaced, not duplicated.
	again := splitConf("[Interface]\nTable = main\ntable=auto\nAddress = 10.0.0.2/32\n")
	if strings.Count(strings.ToLower(again), "table") != 1 {
		t.Fatalf("a Table from the request survived:\n%s", again)
	}
}

func TestConfValues(t *testing.T) {
	if got := confValues(winConf, "allowedips"); len(got) != 2 || got[0] != "0.0.0.0/0" || got[1] != "::/0" {
		t.Fatalf("AllowedIPs: %v", got)
	}
	if got := confValues(winConf, "Address"); !hasV6(got) {
		t.Fatalf("Address: %v", got)
	}
	if hasV6([]string{"10.8.1.2/32"}) {
		t.Fatal("an IPv4-only address is not v6")
	}
}

func TestSplitStore(t *testing.T) {
	path := filepath.Join(t.TempDir(), "split.json")
	req := &proto.Request{Split: &proto.Split{Mode: proto.SplitExclude, Domains: []string{"example.com"}}, Dns: []string{"10.8.1.1"}}
	st := splitStateFrom(req, "203.0.113.5", nil, true)
	s := newSplitStore(path, st)
	defer s.close()

	back, ok := readSplitState(path)
	if !ok || back.Mode != proto.SplitExclude || back.Endpoint != "203.0.113.5" || !back.V6 || back.Domains[0] != "example.com" {
		t.Fatalf("saved state: %+v ok=%v", back, ok)
	}

	s.note(mustAddr("1.2.3.4"), true)
	s.note(mustAddr("5.6.7.8"), true)
	s.note(mustAddr("1.2.3.4"), false)
	s.update(func(st *splitState) { st.Iface = "utun7" })
	back, _ = readSplitState(path)
	if back.Iface != "utun7" || len(back.Routes) != 1 || back.Routes[0] != "5.6.7.8" {
		t.Fatalf("after changes: %+v", back)
	}

	if _, ok := readSplitState(filepath.Join(t.TempDir(), "none.json")); ok {
		t.Fatal("a missing file is no state")
	}
	if err := os.WriteFile(path, []byte("{broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, ok := readSplitState(path); ok {
		t.Fatal("a broken file is no state")
	}
}

func mustAddr(s string) netip.Addr { return netip.MustParseAddr(s) }

func TestConfEndpointIP(t *testing.T) {
	stub := func(host string) []string {
		if host == "vpn.example.com" {
			return []string{"198.51.100.7"}
		}
		return nil
	}
	for conf, want := range map[string]string{
		"[Peer]\nEndpoint = 203.0.113.5:51820\n":     "203.0.113.5",
		"[Peer]\nendpoint=[2001:db8::1]:51820\n":     "2001:db8::1",
		"[Peer]\nEndpoint = vpn.example.com:51820\n": "198.51.100.7",
		"[Peer]\nEndpoint = nowhere.example:51820\n": "",
		"[Peer]\nEndpoint = garbage\n":               "",
		"[Interface]\nAddress = 10.0.0.2/32\n":       "",
	} {
		if got := confEndpointIP(conf, stub); got != want {
			t.Errorf("%q: got %q, want %q", conf, got, want)
		}
	}
}
