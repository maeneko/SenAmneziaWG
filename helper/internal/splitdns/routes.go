package splitdns

import (
	"net/netip"
	"sync"
	"time"
)

// Way is where traffic to an address goes.
type Way int

const (
	WayTunnel Way = iota + 1 // into the tunnel
	WayDirect                // around it, by the physical network
	WayBlock                 // nowhere
)

func (w Way) String() string {
	switch w {
	case WayTunnel:
		return "через туннель"
	case WayDirect:
		return "напрямую"
	case WayBlock:
		return "в никуда"
	}
	return "?"
}

// WayOf is where an action sends traffic; a block has no route to speak of but a black hole.
func WayOf(a Action) Way {
	switch a {
	case ActProxy:
		return WayTunnel
	case ActDirect:
		return WayDirect
	}
	return WayBlock
}

// Router turns «this network goes this way» into the platform's routing change.
type Router interface {
	Route(p netip.Prefix, way Way) error
	Unroute(p netip.Prefix, way Way) error
}

// HostPrefix is the network of one address.
func HostPrefix(ip netip.Addr) netip.Prefix { return netip.PrefixFrom(ip, ip.BitLen()) }

const (
	// RouteTTL is how long an address keeps its route after the last answer that mentioned it.
	RouteTTL = time.Hour
	// MaxRoutes bounds the routing table the proxy may fill; the oldest addresses go first.
	MaxRoutes = 8192
)

type entry struct {
	way Way
	at  time.Time // last answer that mentioned the address
}

// Entry is a route the set holds (the platforms lay them again after the physical gateway changes).
type Entry struct {
	Prefix netip.Prefix
	Way    Way
}

// RouteSet is the helper's own bookkeeping of the routes it added, so nothing outlives it.
type RouteSet struct {
	router Router
	skip   func(netip.Addr) bool
	ttl    time.Duration
	max    int
	now    func() time.Time

	mu     sync.Mutex
	seen   map[netip.Addr]entry
	pinned map[netip.Prefix]Way // not subject to the TTL or the cap: the user's `ip:` rules, DNS servers
}

// NewRouteSet makes a set over router. skip names addresses that must never be routed by name (the server's
// own endpoint: sending that into the tunnel would loop the tunnel into itself).
func NewRouteSet(router Router, skip func(netip.Addr) bool) *RouteSet {
	return &RouteSet{router: router, skip: skip, ttl: RouteTTL, max: MaxRoutes, now: time.Now, seen: map[netip.Addr]entry{}, pinned: map[netip.Prefix]Way{}}
}

// routable: an address a route makes sense for. Loopback, link-local, multicast and the unspecified
// address stay where the system put them.
func routable(ip netip.Addr) bool {
	return ip.IsValid() && !ip.IsLoopback() && !ip.IsUnspecified() && !ip.IsMulticast() &&
		!ip.IsLinkLocalUnicast() && !ip.IsLinkLocalMulticast()
}

// Ensure makes sure ip goes way and remembers when it was last seen. added is true when this call changed the
// routing (a new route, or another way than before).
func (s *RouteSet) Ensure(ip netip.Addr, way Way) (added bool, err error) {
	ip = ip.Unmap()
	if !routable(ip) || (s.skip != nil && s.skip(ip)) {
		return false, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if e, ok := s.seen[ip]; ok {
		if e.way == way {
			s.seen[ip] = entry{way, s.now()}
			return false, nil
		}
		_ = s.router.Unroute(HostPrefix(ip), e.way)
		delete(s.seen, ip)
	}
	if len(s.seen) >= s.max {
		s.evictOldestLocked()
	}
	if err := s.router.Route(HostPrefix(ip), way); err != nil {
		return false, err
	}
	s.seen[ip] = entry{way, s.now()}
	return true, nil
}

func (s *RouteSet) evictOldestLocked() {
	var oldest netip.Addr
	var at time.Time
	for ip, e := range s.seen {
		if !oldest.IsValid() || e.at.Before(at) {
			oldest, at = ip, e.at
		}
	}
	if oldest.IsValid() {
		_ = s.router.Unroute(HostPrefix(oldest), s.seen[oldest].way)
		delete(s.seen, oldest)
	}
}

// Adopt takes over a route the OS already has (one a previous run of the service left): it is tracked and
// expires like any other, without being laid again.
func (s *RouteSet) Adopt(ip netip.Addr, way Way) {
	ip = ip.Unmap()
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.seen[ip]; !ok && routable(ip) && len(s.seen) < s.max {
		s.seen[ip] = entry{way, s.now()}
	}
}

// Pin routes a network for as long as the set lives (the `ip:` rules, the servers' own DNS).
func (s *RouteSet) Pin(p netip.Prefix, way Way) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if old, ok := s.pinned[p]; ok {
		if old == way {
			return nil
		}
		_ = s.router.Unroute(p, old)
		delete(s.pinned, p)
	}
	if err := s.router.Route(p, way); err != nil {
		return err
	}
	s.pinned[p] = way
	return nil
}

// Expire drops the routes nothing has asked for within the TTL. It returns how many went.
func (s *RouteSet) Expire() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	cutoff := s.now().Add(-s.ttl)
	n := 0
	for ip, e := range s.seen {
		if e.at.Before(cutoff) {
			_ = s.router.Unroute(HostPrefix(ip), e.way)
			delete(s.seen, ip)
			n++
		}
	}
	return n
}

// Len is how many addresses are routed by name now.
func (s *RouteSet) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.seen)
}

// Entries lists every route held, pinned ones too.
func (s *RouteSet) Entries() []Entry {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Entry, 0, len(s.seen)+len(s.pinned))
	for ip, e := range s.seen {
		out = append(out, Entry{HostPrefix(ip), e.way})
	}
	for p, w := range s.pinned {
		out = append(out, Entry{p, w})
	}
	return out
}

// Close releases everything. Best effort: one failing route must not keep the others in place.
func (s *RouteSet) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for ip, e := range s.seen {
		_ = s.router.Unroute(HostPrefix(ip), e.way)
		delete(s.seen, ip)
	}
	for p, w := range s.pinned {
		_ = s.router.Unroute(p, w)
		delete(s.pinned, p)
	}
}
