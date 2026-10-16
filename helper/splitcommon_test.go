package main

import (
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"senawg-helper/internal/proto"
	"senawg-helper/internal/splitdns"
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
	req := &proto.Request{Routing: &proto.Routing{Final: proto.FinalProxy, Rules: []proto.RoutingRule{{Action: proto.ActionDirect, Kind: proto.KindSuffix, Value: "example.com"}}}, Dns: []string{"10.8.1.1"}}
	st := splitStateFrom(req, "203.0.113.5", nil, true)
	s := newSplitStore(path, st)
	defer s.close()

	back, ok := readSplitState(path)
	if !ok || back.Final != proto.FinalProxy || back.Endpoint != "203.0.113.5" || !back.V6 || back.Rules[0].Value != "example.com" {
		t.Fatalf("saved state: %+v ok=%v", back, ok)
	}

	s.note(netip.MustParsePrefix("1.2.3.4/32"), splitdns.WayDirect, true)
	s.note(netip.MustParsePrefix("5.6.7.8/32"), splitdns.WayTunnel, true)
	s.note(netip.MustParsePrefix("10.0.0.0/8"), splitdns.WayBlock, true)
	s.note(netip.MustParsePrefix("1.2.3.4/32"), splitdns.WayDirect, false)
	s.update(func(st *splitState) { st.Iface = "utun7" })
	back, _ = readSplitState(path)
	got := map[string]int{}
	for _, r := range back.Routes {
		got[r.P] = r.W
	}
	if back.Iface != "utun7" || len(got) != 2 || got["5.6.7.8"] != int(splitdns.WayTunnel) || got["10.0.0.0/8"] != int(splitdns.WayBlock) {
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

// A file 0.8.x wrote (a mode, a list of sites, plain addresses as routes) is no state to resume from, but it
// still says which routes to remove.
func TestSplitStateFromOldFormat(t *testing.T) {
	path := filepath.Join(t.TempDir(), "split.json")
	old := `{"mode":"exclude","domains":["example.com"],"routes":["1.2.3.4","5.6.7.8"],"iface":"utun4"}`
	if err := os.WriteFile(path, []byte(old), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, ok := readSplitState(path); ok {
		t.Fatal("an old-format file must not be resumed")
	}
	st, ok := looseSplitState(path)
	if !ok || len(st.Routes) != 2 || st.Routes[0].P != "1.2.3.4" || st.Routes[1].W != 0 {
		t.Fatalf("loose read: %+v ok=%v", st, ok)
	}
	if p, ok := parseRouteKey("1.2.3.4"); !ok || p.String() != "1.2.3.4/32" {
		t.Fatalf("parseRouteKey: %v %v", p, ok)
	}
	if p, ok := parseRouteKey("10.0.0.0/8"); !ok || p.Bits() != 8 {
		t.Fatalf("parseRouteKey net: %v %v", p, ok)
	}
	if routeKey(netip.MustParsePrefix("1.2.3.4/32")) != "1.2.3.4" || routeKey(netip.MustParsePrefix("10.0.0.0/8")) != "10.0.0.0/8" {
		t.Fatal("routeKey")
	}
}

func TestStaticRoutes(t *testing.T) {
	rule := func(action, value string) proto.RoutingRule {
		return proto.RoutingRule{Action: action, Kind: proto.KindIP, Value: value}
	}
	names := proto.RoutingRule{Action: proto.ActionProxy, Kind: proto.KindSuffix, Value: "example.com"}

	// Default proxy: what goes the tunnel's way needs nothing; direct and block get routes.
	st := splitState{Final: proto.FinalProxy, Rules: []proto.RoutingRule{
		rule(proto.ActionBlock, "10.0.0.0/8"), rule(proto.ActionProxy, "93.184.216.0/24"), rule(proto.ActionDirect, "192.0.2.1"), names,
		rule(proto.ActionDirect, "10.0.0.0/8"), // named twice: the first rule wins (block, here)
	}}
	got := staticRoutes(st)
	want := map[string]splitdns.Way{"192.0.2.1/32": splitdns.WayDirect, "10.0.0.0/8": splitdns.WayBlock}
	if len(got) != len(want) {
		t.Fatalf("got %v", got)
	}
	for _, e := range got {
		if want[e.Prefix.String()] != e.Way {
			t.Errorf("%v: way %v", e.Prefix, e.Way)
		}
	}

	// Default direct: proxy and block get routes, direct rules none.
	st = splitState{Final: proto.FinalDirect, Rules: []proto.RoutingRule{rule(proto.ActionProxy, "93.184.216.0/24"), rule(proto.ActionDirect, "192.0.2.1"), rule(proto.ActionBlock, "2001:db8::/32")}}
	got = staticRoutes(st)
	if len(got) != 2 || got[0].Prefix.String() != "93.184.216.0/24" || got[0].Way != splitdns.WayTunnel || got[1].Way != splitdns.WayBlock {
		t.Fatalf("default direct: %v", got)
	}
}

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
