// splitcommon.go is what the macOS and Windows services share for «Что идёт через VPN»: the saved state a
// restarted service picks the proxy up from, and the assembly of the proxy itself. No build tag, so it is
// tested everywhere. (Linux keeps its own variant in split_linux.go: its routes and DNS work differently.)
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/netip"
	"os"
	"strings"
	"sync"
	"time"

	"senawg-helper/internal/proto"
	"senawg-helper/internal/splitdns"
)

// splitState is everything needed to start the proxy again and to remove what it left.
type splitState struct {
	Final    string              `json:"final"`
	Rules    []proto.RoutingRule `json:"rules"`
	TunnelNS []string            `json:"tunnelNs,omitempty"`
	DirectNS []string            `json:"directNs,omitempty"`
	V6       bool                `json:"v6,omitempty"`
	Endpoint string              `json:"endpoint,omitempty"`
	Iface    string              `json:"iface,omitempty"`
	// Every route the service laid, so a crash leaves a way to remove them (and a restart a way to carry on).
	Routes []routeRec `json:"routes,omitempty"`
	// Windows: the DNS Client rule that sends every name to the proxy was written and must be removed.
	NRPT bool `json:"nrpt,omitempty"`
}

func splitStateFrom(req *proto.Request, endpoint string, direct []netip.Addr, v6 bool) splitState {
	st := splitState{Final: req.Routing.Final, Rules: req.Routing.Rules, TunnelNS: req.Dns, V6: v6, Endpoint: endpoint}
	for _, ip := range direct {
		st.DirectNS = append(st.DirectNS, ip.String())
	}
	return st
}

// routeRec is one saved route: the network (an address alone for a host) and where it was sent. 0.8.x wrote
// plain address strings; those still read, with no way.
type routeRec struct {
	P string `json:"p"`
	W int    `json:"w,omitempty"`
}

func (r *routeRec) UnmarshalJSON(b []byte) error {
	if len(b) > 0 && b[0] == '"' {
		return json.Unmarshal(b, &r.P)
	}
	type plain routeRec
	return json.Unmarshal(b, (*plain)(r))
}

// finalAction is the default of a routing as the proxy knows it.
func finalAction(final string) splitdns.Action {
	if final == proto.FinalDirect {
		return splitdns.ActDirect
	}
	return splitdns.ActProxy
}

func actionOf(a string) splitdns.Action {
	switch a {
	case proto.ActionProxy:
		return splitdns.ActProxy
	case proto.ActionDirect:
		return splitdns.ActDirect
	}
	return splitdns.ActBlock
}

// dnsRules are the rules that are about names, for the classifier; `ip` rules are the routers' business.
func dnsRules(rules []proto.RoutingRule) []splitdns.Rule {
	var out []splitdns.Rule
	for _, r := range rules {
		out = append(out, splitdns.Rule{Action: actionOf(r.Action), Kind: r.Kind, Value: r.Value})
	}
	return out
}

// staticRoutes are the `ip` rules as networks to route, in the order the rules came; a network named twice goes
// by the first rule. A rule that sends a network where the default sends it needs
// no route.
func staticRoutes(st splitState) []splitdns.Entry {
	rules := st.Rules
	def := splitdns.WayOf(finalAction(st.Final))
	seen := map[netip.Prefix]bool{}
	var out []splitdns.Entry
	for _, r := range rules {
		if r.Kind != proto.KindIP {
			continue
		}
		p, err := proto.ParseRuleIP(r.Value)
		if err != nil || seen[p] {
			continue
		}
		seen[p] = true
		if way := splitdns.WayOf(actionOf(r.Action)); way != def {
			out = append(out, splitdns.Entry{Prefix: p, Way: way})
		}
	}
	return out
}

// routeKey is how a prefix is saved: an address alone for a host, a network otherwise.
func routeKey(p netip.Prefix) string {
	if p.IsSingleIP() {
		return p.Addr().String()
	}
	return p.String()
}

// parseRouteKey reads routeKey's form back (and the plain addresses 0.8.x wrote).
func parseRouteKey(s string) (netip.Prefix, bool) {
	if p, err := netip.ParsePrefix(s); err == nil {
		return p, true
	}
	if a, err := netip.ParseAddr(s); err == nil {
		return splitdns.HostPrefix(a), true
	}
	return netip.Prefix{}, false
}

// splitStore keeps the state file current: written shortly after the set of routes changes, not at every one.
type splitStore struct {
	path  string
	mu    sync.Mutex
	state splitState
	dirty bool
	set   map[string]splitdns.Way
	done  chan struct{}
}

func newSplitStore(path string, st splitState) *splitStore {
	s := &splitStore{path: path, state: st, set: map[string]splitdns.Way{}, done: make(chan struct{})}
	for _, r := range st.Routes {
		s.set[r.P] = splitdns.Way(r.W)
	}
	s.write()
	go func() {
		t := time.NewTicker(time.Second)
		defer t.Stop()
		for {
			select {
			case <-s.done:
				return
			case <-t.C:
				s.flush()
			}
		}
	}()
	return s
}

func (s *splitStore) note(p netip.Prefix, way splitdns.Way, added bool) {
	if s == nil {
		return
	}
	s.mu.Lock()
	if added {
		s.set[routeKey(p)] = way
	} else {
		delete(s.set, routeKey(p))
	}
	s.dirty = true
	s.mu.Unlock()
}

func (s *splitStore) update(f func(*splitState)) {
	s.mu.Lock()
	f(&s.state)
	s.dirty = true
	s.mu.Unlock()
	s.flush()
}

func (s *splitStore) flush() {
	s.mu.Lock()
	dirty := s.dirty
	s.dirty = false
	s.mu.Unlock()
	if dirty {
		s.write()
	}
}

func (s *splitStore) write() {
	s.mu.Lock()
	st := s.state
	st.Routes = nil
	for r, w := range s.set {
		st.Routes = append(st.Routes, routeRec{P: r, W: int(w)})
	}
	s.mu.Unlock()
	b, err := json.Marshal(st)
	if err != nil {
		return
	}
	tmp := s.path + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		_ = os.Rename(tmp, s.path)
	}
}

func (s *splitStore) close() { close(s.done) }

func readSplitState(path string) (splitState, bool) {
	st, ok := looseSplitState(path)
	return st, ok && st.Final != ""
}

// looseSplitState reads whatever the file holds, valid for a run or not: cleaning up needs only its routes, and
// a file from 0.8.x (a mode and a list of sites) still names the routes it laid.
func looseSplitState(path string) (splitState, bool) {
	var st splitState
	b, err := os.ReadFile(path)
	if err != nil || json.Unmarshal(b, &st) != nil {
		return st, false
	}
	return st, true
}

// buildProxy chooses the upstreams the saved state allows and listens on the proxy's address. The caller
// supplies how to dial the system's DNS around the tunnel. The tunnel's DNS is dialled the ordinary way:
// the routes decide, and they send it into the tunnel.
func buildProxy(st splitState, routes *splitdns.RouteSet, directDial splitdns.Dialer, logf func(string, ...any)) (*splitdns.Proxy, error) {
	tunnelNS := splitdns.ParseAddrs(st.TunnelNS)
	directNS := splitdns.ParseAddrs(st.DirectNS)
	var dial net.Dialer
	tunnel := &splitdns.Upstream{Servers: tunnelNS, Dial: dial.DialContext}
	direct := &splitdns.Upstream{Servers: directNS, Dial: directDial}
	classifier, err := splitdns.NewClassifier(dnsRules(st.Rules))
	if err != nil {
		return nil, err
	}
	cfg := splitdns.Config{Final: finalAction(st.Final), Classifier: classifier, TunnelV6: st.V6, Routes: routes, Logf: logf}
	switch {
	case len(tunnelNS) == 0 && len(directNS) == 0:
		return nil, fmt.Errorf("не найден ни один DNS-сервер: ни у туннеля, ни в системе")
	case len(tunnelNS) == 0:
		logf("у туннеля нет DNS — вопросы идут в DNS системы")
		cfg.Tunnel, cfg.Direct = direct, direct
	case len(directNS) == 0:
		logf("DNS системы не найден — все вопросы идут в DNS туннеля")
		cfg.Tunnel = tunnel
	default:
		cfg.Tunnel, cfg.Direct = tunnel, direct
	}

	addr := net.JoinHostPort(splitListenAddr, "53")
	udp, err := net.ListenPacket("udp", addr)
	if err != nil {
		return nil, fmt.Errorf("не удалось занять %s (udp): %w", addr, err)
	}
	tcp, err := net.Listen("tcp", addr)
	if err != nil {
		_ = udp.Close()
		return nil, fmt.Errorf("не удалось занять %s (tcp): %w", addr, err)
	}
	p := splitdns.New(cfg)
	p.Serve(udp, tcp)
	return p, nil
}

func hasV6(addrs []string) bool {
	for _, a := range splitList(addrs) {
		if p, err := netip.ParsePrefix(a); err == nil && p.Addr().Is6() {
			return true
		}
	}
	return false
}

// confValues returns the comma-separated values of every `key = ...` line of a WireGuard .conf.
func confValues(conf, key string) []string {
	var out []string
	for _, line := range strings.Split(conf, "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
		if ok && strings.EqualFold(strings.TrimSpace(k), key) {
			for _, item := range strings.Split(v, ",") {
				if item = strings.TrimSpace(item); item != "" {
					out = append(out, item)
				}
			}
		}
	}
	return out
}

// splitConf is the .conf the tunnel service gets when a split is on: no routes and no firewall of its
// own (`Table = off` — the fork then installs none of either), and the proxy as the interface's DNS.
// ValidateConf has already accepted the app's conf, which has neither key; it refuses them on purpose,
// so they are added here, after it, and never taken from the request.
func splitConf(conf string) string {
	var out []string
	for _, line := range strings.Split(conf, "\n") {
		k, _, ok := strings.Cut(strings.TrimSpace(line), "=")
		if ok {
			if k = strings.ToLower(strings.TrimSpace(k)); k == "dns" || k == "table" {
				continue
			}
		}
		out = append(out, line)
		if strings.EqualFold(strings.TrimSpace(line), "[Interface]") {
			out = append(out, "Table = off", "DNS = "+splitListenAddr)
		}
	}
	return strings.Join(out, "\n")
}

// confEndpointIP is the server's address from a .conf's `Endpoint = host:port`: the host as it is when it
// is an address, otherwise its first address from the system's DNS (the proxy is not up yet, so the
// answer is the system's own). Empty when it cannot be found: the proxy then has nothing to keep out.
func confEndpointIP(conf string, lookup func(host string) []string) string {
	vals := confValues(conf, "Endpoint")
	if len(vals) == 0 {
		return ""
	}
	host, _, err := net.SplitHostPort(vals[0])
	if err != nil {
		return ""
	}
	if ip, err := netip.ParseAddr(host); err == nil {
		return ip.Unmap().String()
	}
	if lookup != nil {
		if ips := lookup(host); len(ips) > 0 {
			return ips[0]
		}
	}
	return ""
}

// lookupHost resolves with a short deadline: a connection must not hang on a name.
func lookupHost(host string) []string {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	ips, _ := net.DefaultResolver.LookupHost(ctx, host)
	return ips
}
