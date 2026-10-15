package splitdns

import (
	"context"
	"encoding/binary"
	"io"
	"net"
	"net/netip"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

const (
	// MaxAnswerTTL is the longest an application may cache an address of a listed name: it asks again
	// at least this often, and every ask renews the route's lifetime.
	MaxAnswerTTL = 300

	maxInflight = 256
)

// refused names whose answer tells browsers and systems to stop doing something that would carry
// traffic past this proxy: Firefox's DNS over HTTPS and Apple's iCloud Private Relay both ask for
// these and step back on NXDOMAIN.
var refused = map[string]bool{
	"use-application-dns.net": true,
	"mask.icloud.com":         true,
	"mask-h2.icloud.com":      true,
}

// Config describes one run of the proxy.
type Config struct {
	Mode    string   // proto.SplitInclude or proto.SplitExclude
	Domains []string // the list that mode uses
	// Tunnel answers questions about names that go through the tunnel; Direct, the ones that do not.
	// Direct may be nil (the system's own DNS could not be found): everything is then asked through Tunnel.
	Tunnel, Direct Exchanger
	// TunnelV6: the tunnel carries IPv6. Without it an AAAA question about a name that goes through the
	// tunnel gets an empty answer, so the application falls back to IPv4 instead of leaving the tunnel.
	TunnelV6 bool
	Routes   *RouteSet
	Logf     func(format string, args ...any)
}

// Proxy is the DNS front the system's resolver is pointed at.
type Proxy struct {
	cfg     Config
	matcher *Matcher
	sem     chan struct{}

	mu      sync.Mutex
	closers []io.Closer
	conns   map[net.Conn]struct{} // open TCP clients, closed by Close so it never waits for an idle one
	done    chan struct{}
	wg      sync.WaitGroup
}

func New(cfg Config) *Proxy {
	if cfg.Logf == nil {
		cfg.Logf = func(string, ...any) {}
	}
	return &Proxy{cfg: cfg, matcher: NewMatcher(cfg.Domains), sem: make(chan struct{}, maxInflight), done: make(chan struct{}), conns: map[net.Conn]struct{}{}}
}

// viaTunnel: whether traffic to a name goes through the tunnel. Listed names take the way opposite to
// the mode's default (include: default is direct, so listed go through; exclude: the other way round).
func (p *Proxy) viaTunnel(listed bool) bool { return listed == (p.cfg.Mode == "include") }

// Handle answers one DNS message; nil means «say nothing» (not a DNS message at all).
func (p *Proxy) Handle(ctx context.Context, query []byte, overTCP bool) []byte {
	var q dnsmessage.Message
	if err := q.Unpack(query); err != nil {
		if len(query) >= 2 { // a header at least: tell the client its message was malformed
			return rcodeReply(binary.BigEndian.Uint16(query), nil, dnsmessage.RCodeFormatError)
		}
		return nil
	}
	if q.Response || q.OpCode != 0 || len(q.Questions) != 1 {
		return rcodeReply(q.ID, q.Questions, dnsmessage.RCodeNotImplemented)
	}
	question := q.Questions[0]
	name := strings.ToLower(strings.TrimSuffix(question.Name.String(), "."))

	if refused[name] {
		return rcodeReply(q.ID, q.Questions, dnsmessage.RCodeNameError)
	}

	listed := p.matcher.Match(name)
	tunnel := p.viaTunnel(listed)
	if tunnel && !p.cfg.TunnelV6 && question.Type == dnsmessage.TypeAAAA {
		return rcodeReply(q.ID, q.Questions, dnsmessage.RCodeSuccess)
	}

	up := p.cfg.Tunnel
	if !tunnel && p.cfg.Direct != nil {
		up = p.cfg.Direct
	}
	resp, err := up.Exchange(ctx, query, overTCP)
	if err != nil {
		p.cfg.Logf("DNS %s: %v", name, err)
		return rcodeReply(q.ID, q.Questions, dnsmessage.RCodeServerFailure)
	}
	if !listed {
		return resp
	}
	return p.divert(resp, name)
}

// divert routes the addresses of an answer about a listed name the other way and caps their TTL. The
// routes are in place before the answer is handed back, so the first packet already takes them.
func (p *Proxy) divert(resp []byte, name string) []byte {
	var m dnsmessage.Message
	if err := m.Unpack(resp); err != nil {
		return resp
	}
	capped := false
	for i := range m.Answers {
		r := &m.Answers[i]
		if r.Header.TTL > MaxAnswerTTL {
			r.Header.TTL = MaxAnswerTTL
			capped = true
		}
		var ip netip.Addr
		switch body := r.Body.(type) {
		case *dnsmessage.AResource:
			ip = netip.AddrFrom4(body.A)
		case *dnsmessage.AAAAResource:
			ip = netip.AddrFrom16(body.AAAA)
		default:
			continue
		}
		added, err := p.cfg.Routes.Ensure(ip)
		switch {
		case err != nil:
			p.cfg.Logf("маршрут для %s (%s): %v", name, ip, err)
		case added:
			p.cfg.Logf("%s → %s: %s", name, ip, p.wayWord())
		}
	}
	if !capped {
		return resp
	}
	out, err := m.Pack()
	if err != nil {
		return resp
	}
	return out
}

func (p *Proxy) wayWord() string {
	if p.cfg.Mode == "include" {
		return "через туннель"
	}
	return "напрямую"
}

func rcodeReply(id uint16, questions []dnsmessage.Question, rcode dnsmessage.RCode) []byte {
	m := dnsmessage.Message{
		Header:    dnsmessage.Header{ID: id, Response: true, RecursionAvailable: true, RCode: rcode},
		Questions: questions,
	}
	out, err := m.Pack()
	if err != nil {
		return nil
	}
	return out
}

// Serve answers on udp and tcp until Close. Both may be nil.
func (p *Proxy) Serve(udp net.PacketConn, tcp net.Listener) {
	p.mu.Lock()
	if udp != nil {
		p.closers = append(p.closers, udp)
	}
	if tcp != nil {
		p.closers = append(p.closers, tcp)
	}
	p.mu.Unlock()
	if udp != nil {
		p.wg.Add(1)
		go p.serveUDP(udp)
	}
	if tcp != nil {
		p.wg.Add(1)
		go p.serveTCP(tcp)
	}
	p.wg.Add(1)
	go p.expireLoop()
}

func (p *Proxy) serveUDP(c net.PacketConn) {
	defer p.wg.Done()
	buf := make([]byte, 65535)
	for {
		n, addr, err := c.ReadFrom(buf)
		if err != nil {
			return
		}
		msg := append([]byte(nil), buf[:n]...)
		select {
		case p.sem <- struct{}{}:
		default:
			continue // overloaded: the client asks again
		}
		p.wg.Add(1)
		go func() {
			defer p.wg.Done()
			defer func() { <-p.sem }()
			ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
			defer cancel()
			if out := p.Handle(ctx, msg, false); out != nil {
				_, _ = c.WriteTo(out, addr)
			}
		}()
	}
}

func (p *Proxy) serveTCP(l net.Listener) {
	defer p.wg.Done()
	for {
		conn, err := l.Accept()
		if err != nil {
			return
		}
		p.mu.Lock()
		select {
		case <-p.done: // Close ran between Accept and here
			p.mu.Unlock()
			conn.Close()
			return
		default:
		}
		p.conns[conn] = struct{}{}
		p.mu.Unlock()
		p.wg.Add(1)
		go func() {
			defer p.wg.Done()
			defer func() {
				p.mu.Lock()
				delete(p.conns, conn)
				p.mu.Unlock()
				conn.Close()
			}()
			p.serveConn(conn)
		}()
	}
}

func (p *Proxy) serveConn(conn net.Conn) {
	for {
		_ = conn.SetDeadline(time.Now().Add(15 * time.Second))
		var n [2]byte
		if _, err := io.ReadFull(conn, n[:]); err != nil {
			return
		}
		msg := make([]byte, binary.BigEndian.Uint16(n[:]))
		if _, err := io.ReadFull(conn, msg); err != nil {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		out := p.Handle(ctx, msg, true)
		cancel()
		if out == nil {
			return
		}
		if _, err := conn.Write(append(binary.BigEndian.AppendUint16(nil, uint16(len(out))), out...)); err != nil {
			return
		}
	}
}

func (p *Proxy) expireLoop() {
	defer p.wg.Done()
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-p.done:
			return
		case <-t.C:
			if n := p.cfg.Routes.Expire(); n > 0 {
				p.cfg.Logf("раздельный режим: убрано устаревших маршрутов — %d", n)
			}
		}
	}
}

// Close stops listening, waits for the answers in flight and removes every route it added.
func (p *Proxy) Close() {
	select {
	case <-p.done:
		return
	default:
		close(p.done)
	}
	p.mu.Lock()
	for _, c := range p.closers {
		_ = c.Close()
	}
	for c := range p.conns {
		_ = c.Close()
	}
	p.mu.Unlock()
	p.wg.Wait()
	p.cfg.Routes.Close()
}
