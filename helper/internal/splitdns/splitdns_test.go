package splitdns

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/netip"
	"sync"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

func TestMatcher(t *testing.T) {
	m := NewMatcher([]string{"example.com", "a.b.org"})
	for name, want := range map[string]bool{
		"example.com":         true,
		"www.example.com":     true,
		"x.y.example.com":     true,
		"badexample.com":      false,
		"example.com.evil.io": false,
		"com":                 false,
		"b.org":               false,
		"a.b.org":             true,
		"c.a.b.org":           true,
		"other.org":           false,
	} {
		if got := m.Match(name); got != want {
			t.Errorf("Match(%q) = %v, want %v", name, got, want)
		}
	}
}

// The first matching rule wins, in the order the rules came: with block listed first, a name under both is blocked.
func TestClassifierKeepsTheOrderOfTheRules(t *testing.T) {
	c, err := NewClassifier([]Rule{
		rule(ActBlock, "suffix", "ads.example.com"),
		rule(ActProxy, "suffix", "example.com"),
		rule(ActProxy, "ip", "10.0.0.0/8"), // between two rules of one action: no break in the run
		rule(ActProxy, "keyword", "shop"),
		rule(ActDirect, "domain", "shop.example.com"),
	})
	if err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]Action{
		"ads.example.com":   ActBlock,
		"x.ads.example.com": ActBlock,
		"www.example.com":   ActProxy,
		"shop.example.com":  ActProxy, // proxy (suffix example.com) comes before the direct rule
		"myshop.io":         ActProxy,
	} {
		if got, ok := c.Classify(name); !ok || got != want {
			t.Errorf("Classify(%q) = %v %v, want %v", name, got, ok, want)
		}
	}
	// Same rules, direct first: now the exact name is direct.
	c2, _ := NewClassifier([]Rule{rule(ActDirect, "domain", "shop.example.com"), rule(ActProxy, "suffix", "example.com")})
	if got, _ := c2.Classify("shop.example.com"); got != ActDirect {
		t.Errorf("direct first: %v", got)
	}
	if got, _ := c2.Classify("www.example.com"); got != ActProxy {
		t.Errorf("proxy after: %v", got)
	}
}

func rule(a Action, kind, value string) Rule { return Rule{Action: a, Kind: kind, Value: value} }

func TestClassifier(t *testing.T) {
	c, err := NewClassifier([]Rule{
		rule(ActProxy, "domain", "nura.eco"),
		rule(ActProxy, "suffix", "example.com"),
		rule(ActDirect, "keyword", "bank"),
		rule(ActDirect, "regex", `^cdn[0-9]+\.shop\.ru$`),
		rule(ActBlock, "suffix", "ads.example.com"),
		rule(ActBlock, "suffix", "tracker.net"),
		rule(ActBlock, "ip", "10.0.0.0/8"), // not about names: ignored here
	})
	if err != nil {
		t.Fatal(err)
	}
	if c.Len() != 6 {
		t.Fatalf("Len = %d", c.Len())
	}
	for name, want := range map[string]Action{
		"nura.eco":           ActProxy,
		"www.nura.eco":       0, // «domain:» is that name only
		"example.com":        ActProxy,
		"www.example.com":    ActProxy,
		"badexample.com":     0,
		"mybank.ru":          ActDirect,
		"bankofsomething.io": ActDirect,
		"cdn7.shop.ru":       ActDirect,
		"cdnx.shop.ru":       0,
		"tracker.net":        ActBlock,
		"a.tracker.net":      ActBlock,
		"other.org":          0,
		// Proxy is tried before block: ads.example.com is under example.com too.
		"ads.example.com": ActProxy,
	} {
		got, ok := c.Classify(name)
		if want == 0 && ok || want != 0 && (!ok || got != want) {
			t.Errorf("Classify(%q) = %v %v, want %v", name, got, ok, want)
		}
	}
	if _, err := NewClassifier([]Rule{rule(ActProxy, "regex", "(")}); err == nil {
		t.Fatal("a bad regular expression must be an error")
	}
	empty, _ := NewClassifier(nil)
	if _, ok := empty.Classify("example.com"); ok {
		t.Fatal("an empty classifier matches nothing")
	}
}

type fakeRouter struct {
	mu     sync.Mutex
	routes map[netip.Prefix]Way
	fail   bool
}

func newFakeRouter() *fakeRouter { return &fakeRouter{routes: map[netip.Prefix]Way{}} }

func (r *fakeRouter) Route(p netip.Prefix, way Way) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.fail {
		return errors.New("route: boom")
	}
	r.routes[p] = way
	return nil
}

func (r *fakeRouter) Unroute(p netip.Prefix, way Way) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.routes[p] == way {
		delete(r.routes, p)
	}
	return nil
}

func (r *fakeRouter) has(ip string) (Way, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	w, ok := r.routes[HostPrefix(netip.MustParseAddr(ip))]
	return w, ok
}

func TestRouteSet(t *testing.T) {
	r := newFakeRouter()
	now := time.Unix(1000, 0)
	s := NewRouteSet(r, func(ip netip.Addr) bool { return ip == netip.MustParseAddr("9.9.9.9") })
	s.now = func() time.Time { return now }
	s.max = 3

	a := netip.MustParseAddr
	if added, err := s.Ensure(a("1.1.1.1"), WayDirect); !added || err != nil {
		t.Fatalf("first Ensure: %v %v", added, err)
	}
	if added, _ := s.Ensure(a("1.1.1.1"), WayDirect); added {
		t.Fatal("second Ensure must not add again")
	}
	for _, skipped := range []string{"9.9.9.9", "127.0.0.1", "0.0.0.0", "169.254.1.1", "224.0.0.1", "fe80::1"} {
		if added, _ := s.Ensure(a(skipped), WayDirect); added {
			t.Errorf("%s must not be routed", skipped)
		}
		if _, ok := r.has(skipped); ok {
			t.Errorf("%s was routed", skipped)
		}
	}
	// ::ffff:1.2.3.4 is the same host as 1.2.3.4. Every address gets its own moment, so «oldest» is exact.
	now = now.Add(time.Second)
	if _, err := s.Ensure(a("::ffff:1.2.3.4"), WayTunnel); err != nil {
		t.Fatal(err)
	}
	if w, ok := r.has("1.2.3.4"); !ok || w != WayTunnel {
		t.Fatal("v4-mapped address must be unmapped")
	}

	// The cap: the oldest goes first.
	now = now.Add(time.Second)
	s.Ensure(a("2.2.2.2"), WayDirect)
	now = now.Add(time.Second)
	s.Ensure(a("3.3.3.3"), WayDirect)
	if _, ok := r.has("1.1.1.1"); ok || s.Len() != 3 {
		t.Fatalf("oldest not evicted: len %d, %v", s.Len(), r.routes)
	}

	// The TTL: only what was seen recently stays.
	now = now.Add(RouteTTL - time.Second)
	s.Ensure(a("3.3.3.3"), WayDirect)
	now = now.Add(2 * time.Second)
	if n := s.Expire(); n != 2 {
		t.Fatalf("Expire released %d: %v", n, r.routes)
	}
	if _, ok := r.has("3.3.3.3"); !ok {
		t.Fatal("the recently seen address must stay")
	}

	s.Close()
	if len(r.routes) != 0 || s.Len() != 0 {
		t.Fatalf("Close left routes: %v", r.routes)
	}

	r.fail = true
	if _, err := s.Ensure(a("5.5.5.5"), WayDirect); err == nil || s.Len() != 0 {
		t.Fatal("a failed route must not be remembered")
	}
}

func TestRouteSetChangesWay(t *testing.T) {
	r := newFakeRouter()
	s := NewRouteSet(r, nil)
	ip := netip.MustParseAddr("8.8.4.4")
	s.Ensure(ip, WayDirect)
	if added, _ := s.Ensure(ip, WayBlock); !added {
		t.Fatal("another way is a change")
	}
	if w, _ := r.has("8.8.4.4"); w != WayBlock || len(r.routes) != 1 {
		t.Fatalf("the old way must be gone: %v", r.routes)
	}
}

func TestRouteSetPin(t *testing.T) {
	r := newFakeRouter()
	now := time.Unix(1000, 0)
	s := NewRouteSet(r, nil)
	s.now = func() time.Time { return now }
	s.max = 1
	net10 := netip.MustParsePrefix("10.0.0.0/8")
	if err := s.Pin(net10, WayBlock); err != nil {
		t.Fatal(err)
	}
	if err := s.Pin(net10, WayBlock); err != nil {
		t.Fatal(err)
	}
	// A pinned network is neither evicted by the cap nor expired by the TTL.
	s.Ensure(netip.MustParseAddr("1.1.1.1"), WayDirect)
	s.Ensure(netip.MustParseAddr("2.2.2.2"), WayDirect)
	now = now.Add(2 * RouteTTL)
	s.Expire()
	if r.routes[net10] != WayBlock {
		t.Fatalf("pinned route lost: %v", r.routes)
	}
	entries := map[netip.Prefix]Way{}
	for _, e := range s.Entries() {
		entries[e.Prefix] = e.Way
	}
	if entries[net10] != WayBlock {
		t.Fatalf("Entries must list pins: %v", entries)
	}
	s.Close()
	if len(r.routes) != 0 {
		t.Fatalf("Close must release pins too: %v", r.routes)
	}
}

type fakeUpstream struct {
	answer func(q dnsmessage.Message) dnsmessage.Message
	calls  int
	err    error
	mu     sync.Mutex
}

func (f *fakeUpstream) Exchange(_ context.Context, query []byte, _ bool) ([]byte, error) {
	f.mu.Lock()
	f.calls++
	err := f.err
	f.mu.Unlock()
	if err != nil {
		return nil, err
	}
	var q dnsmessage.Message
	if err := q.Unpack(query); err != nil {
		return nil, err
	}
	m := f.answer(q)
	return m.Pack()
}

func answerA(ttl uint32, ips ...[4]byte) func(dnsmessage.Message) dnsmessage.Message {
	return func(q dnsmessage.Message) dnsmessage.Message {
		m := dnsmessage.Message{Header: dnsmessage.Header{ID: q.ID, Response: true}, Questions: q.Questions}
		for _, ip := range ips {
			m.Answers = append(m.Answers, dnsmessage.Resource{
				Header: dnsmessage.ResourceHeader{Name: q.Questions[0].Name, Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET, TTL: ttl},
				Body:   &dnsmessage.AResource{A: ip},
			})
		}
		return m
	}
}

func query(t *testing.T, name string, typ dnsmessage.Type) []byte {
	t.Helper()
	n, err := dnsmessage.NewName(name + ".")
	if err != nil {
		t.Fatal(err)
	}
	b, err := (&dnsmessage.Message{
		Header:    dnsmessage.Header{ID: 0x1234, RecursionDesired: true},
		Questions: []dnsmessage.Question{{Name: n, Type: typ, Class: dnsmessage.ClassINET}},
	}).Pack()
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func unpack(t *testing.T, b []byte) dnsmessage.Message {
	t.Helper()
	var m dnsmessage.Message
	if err := m.Unpack(b); err != nil {
		t.Fatalf("bad answer: %v", err)
	}
	return m
}

// newProxy: one listed name (example.com), with the default the old modes had: «exclude» sends the list around the
// tunnel (default proxy), «include» sends it into the tunnel (default direct).
func newProxy(mode string, v6 bool) (*Proxy, *fakeUpstream, *fakeUpstream, *fakeRouter) {
	tunnel := &fakeUpstream{answer: answerA(3600, [4]byte{10, 0, 0, 1})}
	direct := &fakeUpstream{answer: answerA(3600, [4]byte{20, 0, 0, 2})}
	r := newFakeRouter()
	final, act := ActProxy, ActDirect
	if mode == "include" {
		final, act = ActDirect, ActProxy
	}
	cls, _ := NewClassifier([]Rule{rule(act, "suffix", "example.com")})
	p := New(Config{Final: final, Classifier: cls, Tunnel: tunnel, Direct: direct, TunnelV6: v6, Routes: NewRouteSet(r, nil)})
	return p, tunnel, direct, r
}

func TestProxyExcludeMode(t *testing.T) {
	p, tunnel, direct, r := newProxy("exclude", true)
	ctx := context.Background()

	// A listed name: asked on the direct side, its address routed around the tunnel before the answer returns.
	out := unpack(t, p.Handle(ctx, query(t, "www.Example.com", dnsmessage.TypeA), false))
	if direct.calls != 1 || tunnel.calls != 0 {
		t.Fatalf("calls: direct %d tunnel %d", direct.calls, tunnel.calls)
	}
	if w, ok := r.has("20.0.0.2"); !ok || w != WayDirect {
		t.Fatalf("address not routed around the tunnel: %v", r.routes)
	}
	if ttl := out.Answers[0].Header.TTL; ttl != MaxAnswerTTL {
		t.Fatalf("TTL %d, want capped to %d", ttl, MaxAnswerTTL)
	}

	// Any other name: through the tunnel, answer untouched, nothing routed.
	raw := p.Handle(ctx, query(t, "other.org", dnsmessage.TypeA), false)
	if unpack(t, raw).Answers[0].Header.TTL != 3600 || tunnel.calls != 1 || len(r.routes) != 1 {
		t.Fatalf("unlisted name was touched: %v", r.routes)
	}
}

func TestProxyIncludeMode(t *testing.T) {
	p, tunnel, direct, r := newProxy("include", true)
	ctx := context.Background()
	p.Handle(ctx, query(t, "example.com", dnsmessage.TypeA), false)
	if w, ok := r.has("10.0.0.1"); tunnel.calls != 1 || direct.calls != 0 || !ok || w != WayTunnel {
		t.Fatalf("listed name: tunnel %d direct %d %v", tunnel.calls, direct.calls, r.routes)
	}
	p.Handle(ctx, query(t, "other.org", dnsmessage.TypeA), false)
	if direct.calls != 1 || len(r.routes) != 1 {
		t.Fatalf("unlisted name: direct %d %v", direct.calls, r.routes)
	}
}

func TestProxyNoDirectFallsBackToTunnel(t *testing.T) {
	p, tunnel, _, _ := newProxy("include", true)
	p.cfg.Direct = nil
	if out := p.Handle(context.Background(), query(t, "other.org", dnsmessage.TypeA), false); unpack(t, out).RCode != dnsmessage.RCodeSuccess || tunnel.calls != 1 {
		t.Fatal("without a direct resolver the tunnel's one must answer")
	}
}

func TestProxyAAAAWithoutTunnelV6(t *testing.T) {
	p, tunnel, _, _ := newProxy("include", false)
	out := unpack(t, p.Handle(context.Background(), query(t, "example.com", dnsmessage.TypeAAAA), false))
	if len(out.Answers) != 0 || out.RCode != dnsmessage.RCodeSuccess || tunnel.calls != 0 {
		t.Fatal("AAAA for a name that goes through an IPv4-only tunnel must be empty and not asked")
	}
	// A name that goes the direct way keeps its AAAA.
	p2, _, d2, _ := newProxy("include", false)
	p2.Handle(context.Background(), query(t, "other.org", dnsmessage.TypeAAAA), false)
	if d2.calls != 1 {
		t.Fatal("AAAA for a direct name must be asked")
	}
}

func TestProxyRefusedNames(t *testing.T) {
	p, tunnel, direct, _ := newProxy("exclude", true)
	for _, n := range []string{"use-application-dns.net", "mask.icloud.com", "MASK-H2.icloud.com"} {
		if out := unpack(t, p.Handle(context.Background(), query(t, n, dnsmessage.TypeA), false)); out.RCode != dnsmessage.RCodeNameError {
			t.Errorf("%s: rcode %v", n, out.RCode)
		}
	}
	if tunnel.calls+direct.calls != 0 {
		t.Fatal("refused names must not be forwarded")
	}
}

func TestProxyUpstreamFailureAndRouteFailure(t *testing.T) {
	p, tunnel, _, _ := newProxy("exclude", true)
	tunnel.err = errors.New("timeout")
	if out := unpack(t, p.Handle(context.Background(), query(t, "other.org", dnsmessage.TypeA), false)); out.RCode != dnsmessage.RCodeServerFailure {
		t.Fatalf("rcode %v", out.RCode)
	}

	// A route that cannot be added is logged, and the answer still goes out.
	p, _, _, r := newProxy("exclude", true)
	r.fail = true
	if out := unpack(t, p.Handle(context.Background(), query(t, "example.com", dnsmessage.TypeA), false)); len(out.Answers) != 1 {
		t.Fatal("answer must still be delivered")
	}
}

func TestProxyMalformed(t *testing.T) {
	p, _, _, _ := newProxy("exclude", true)
	if p.Handle(context.Background(), []byte{1}, false) != nil {
		t.Fatal("a single byte is not a DNS message")
	}
	if out := p.Handle(context.Background(), []byte{0xab, 0xcd, 0xff, 0xff, 0xff}, false); out == nil || out[0] != 0xab || out[1] != 0xcd {
		t.Fatal("a broken message gets FORMERR with its own id")
	}
}

func TestServeUDPAndTCP(t *testing.T) {
	p, _, _, r := newProxy("exclude", true)
	udp, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Skip("no loopback sockets:", err)
	}
	tcp, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Skip("no loopback sockets:", err)
	}
	p.Serve(udp, tcp)

	q := query(t, "example.com", dnsmessage.TypeA)

	c, err := net.Dial("udp", udp.LocalAddr().String())
	if err != nil {
		t.Fatal(err)
	}
	_ = c.SetDeadline(time.Now().Add(3 * time.Second))
	c.Write(q)
	buf := make([]byte, 4096)
	n, err := c.Read(buf)
	if err != nil || len(unpack(t, buf[:n]).Answers) != 1 {
		t.Fatalf("udp: %v", err)
	}
	c.Close()

	tc, err := net.Dial("tcp", tcp.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	_ = tc.SetDeadline(time.Now().Add(3 * time.Second))
	for i := 0; i < 2; i++ { // two questions on one connection
		tc.Write(append(binary.BigEndian.AppendUint16(nil, uint16(len(q))), q...))
		var l [2]byte
		if _, err := io.ReadFull(tc, l[:]); err != nil {
			t.Fatalf("tcp read %d: %v", i, err)
		}
		msg := make([]byte, binary.BigEndian.Uint16(l[:]))
		if _, err := io.ReadFull(tc, msg); err != nil || len(unpack(t, msg).Answers) != 1 {
			t.Fatalf("tcp answer %d: %v", i, err)
		}
	}
	tc.Close()

	p.Close()
	if len(r.routes) != 0 {
		t.Fatalf("Close must remove the routes: %v", r.routes)
	}
	p.Close() // twice is fine
}

// A network that drops UDP/53 to a resolver but lets TCP through: the same server must be tried over TCP.
func TestUpstreamFallsBackToTCP(t *testing.T) {
	tcpLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Skip("no loopback sockets:", err)
	}
	defer tcpLn.Close()
	silent, err := net.ListenPacket("udp", "127.0.0.1:0") // reads nothing, answers nothing
	if err != nil {
		t.Skip("no loopback sockets:", err)
	}
	defer silent.Close()

	go func() {
		for {
			c, err := tcpLn.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				var l [2]byte
				if _, err := io.ReadFull(c, l[:]); err != nil {
					return
				}
				q := make([]byte, binary.BigEndian.Uint16(l[:]))
				if _, err := io.ReadFull(c, q); err != nil {
					return
				}
				var m dnsmessage.Message
				if m.Unpack(q) != nil {
					return
				}
				ans := answerA(60, [4]byte{9, 9, 9, 9})(m)
				out, _ := ans.Pack()
				c.Write(append(binary.BigEndian.AppendUint16(nil, uint16(len(out))), out...))
			}()
		}
	}()

	dial := func(ctx context.Context, network, _ string) (net.Conn, error) {
		var d net.Dialer
		if network == "tcp" {
			return d.DialContext(ctx, "tcp", tcpLn.Addr().String())
		}
		return d.DialContext(ctx, "udp", silent.LocalAddr().String())
	}
	u := &Upstream{Servers: []netip.Addr{netip.MustParseAddr("1.0.0.1")}, Dial: dial, Timeout: 300 * time.Millisecond}
	resp, err := u.Exchange(context.Background(), query(t, "example.com", dnsmessage.TypeA), false)
	if err != nil {
		t.Fatalf("no TCP fallback: %v", err)
	}
	if got := unpack(t, resp).Answers; len(got) != 1 {
		t.Fatalf("answers: %v", got)
	}
}

// The system's own DNS does not answer: the listed name is still resolved (by the tunnel's DNS) and routed.
func TestProxyDirectFailureFallsBackToTunnel(t *testing.T) {
	p, tunnel, direct, r := newProxy("exclude", true)
	direct.err = errors.New("i/o timeout")
	out := unpack(t, p.Handle(context.Background(), query(t, "www.example.com", dnsmessage.TypeA), false))
	if out.RCode != dnsmessage.RCodeSuccess || len(out.Answers) != 1 {
		t.Fatalf("rcode %v answers %d", out.RCode, len(out.Answers))
	}
	if direct.calls != 1 || tunnel.calls != 1 {
		t.Fatalf("calls: direct %d tunnel %d", direct.calls, tunnel.calls)
	}
	if w, ok := r.has("10.0.0.1"); !ok || w != WayDirect {
		t.Fatalf("the name must still be routed the way the list says: %v", r.routes)
	}

	// Both sides down: SERVFAIL, as before.
	tunnel.err = errors.New("i/o timeout")
	if out := unpack(t, p.Handle(context.Background(), query(t, "www.example.com", dnsmessage.TypeA), false)); out.RCode != dnsmessage.RCodeServerFailure {
		t.Fatalf("rcode %v", out.RCode)
	}
}

// A name under a block rule is not asked about at all and gets NXDOMAIN; the default and the other rules are untouched.
func TestProxyBlockAndThreeWays(t *testing.T) {
	tunnel := &fakeUpstream{answer: answerA(3600, [4]byte{10, 0, 0, 1})}
	direct := &fakeUpstream{answer: answerA(3600, [4]byte{20, 0, 0, 2})}
	r := newFakeRouter()
	cls, _ := NewClassifier([]Rule{
		rule(ActProxy, "suffix", "vpn.example"),
		rule(ActDirect, "suffix", "direct.example"),
		rule(ActBlock, "suffix", "ads.example"),
	})
	p := New(Config{Final: ActProxy, Classifier: cls, Tunnel: tunnel, Direct: direct, TunnelV6: true, Routes: NewRouteSet(r, nil)})
	ctx := context.Background()

	if out := unpack(t, p.Handle(ctx, query(t, "x.ads.example", dnsmessage.TypeA), false)); out.RCode != dnsmessage.RCodeNameError || len(out.Answers) != 0 {
		t.Fatalf("blocked name: rcode %v answers %d", out.RCode, len(out.Answers))
	}
	if tunnel.calls+direct.calls != 0 {
		t.Fatal("a blocked name must not be asked about")
	}
	// The same for AAAA and any other type.
	if out := unpack(t, p.Handle(ctx, query(t, "ads.example", dnsmessage.TypeAAAA), false)); out.RCode != dnsmessage.RCodeNameError {
		t.Fatalf("blocked AAAA: %v", out.RCode)
	}

	// Default is proxy: a proxy rule needs no route, a direct rule gets one.
	p.Handle(ctx, query(t, "www.vpn.example", dnsmessage.TypeA), false)
	if len(r.routes) != 0 || tunnel.calls != 1 {
		t.Fatalf("a name that takes the default way must not be routed: %v", r.routes)
	}
	p.Handle(ctx, query(t, "www.direct.example", dnsmessage.TypeA), false)
	if w, ok := r.has("20.0.0.2"); !ok || w != WayDirect || direct.calls != 1 {
		t.Fatalf("direct rule: %v calls %d", r.routes, direct.calls)
	}
}
