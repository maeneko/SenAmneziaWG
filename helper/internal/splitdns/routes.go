package splitdns

import (
	"net/netip"
	"sync"
	"time"
)

// Router turns «this address takes the other way» into the platform's routing change. Which way is
// «other» is the router's own business: it is built for one mode, so in include mode Divert sends the
// address into the tunnel and in exclude mode it sends it around the tunnel.
type Router interface {
	Divert(ip netip.Addr) error
	Release(ip netip.Addr) error
}

const (
	// RouteTTL is how long an address keeps its route after the last answer that mentioned it.
	RouteTTL = time.Hour
	// MaxRoutes bounds the routing table the proxy may fill; the oldest addresses go first.
	MaxRoutes = 8192
)

// RouteSet is the helper's own bookkeeping of the routes it added, so nothing outlives it.
type RouteSet struct {
	router Router
	skip   func(netip.Addr) bool
	ttl    time.Duration
	max    int
	now    func() time.Time

	mu   sync.Mutex
	seen map[netip.Addr]time.Time // last answer that mentioned the address
}

// NewRouteSet makes a set over router. skip names addresses that must never be diverted (the server's
// own endpoint: routing that into the tunnel would loop the tunnel into itself).
func NewRouteSet(router Router, skip func(netip.Addr) bool) *RouteSet {
	return &RouteSet{router: router, skip: skip, ttl: RouteTTL, max: MaxRoutes, now: time.Now, seen: map[netip.Addr]time.Time{}}
}

// divertable: an address a route makes sense for. Loopback, link-local, multicast and the unspecified
// address stay where the system put them.
func divertable(ip netip.Addr) bool {
	return ip.IsValid() && !ip.IsLoopback() && !ip.IsUnspecified() && !ip.IsMulticast() &&
		!ip.IsLinkLocalUnicast() && !ip.IsLinkLocalMulticast()
}

// Ensure makes sure ip is diverted and remembers when it was last seen. added is true when this call
// installed the route.
func (s *RouteSet) Ensure(ip netip.Addr) (added bool, err error) {
	ip = ip.Unmap()
	if !divertable(ip) || (s.skip != nil && s.skip(ip)) {
		return false, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.seen[ip]; ok {
		s.seen[ip] = s.now()
		return false, nil
	}
	if len(s.seen) >= s.max {
		s.evictOldestLocked()
	}
	if err := s.router.Divert(ip); err != nil {
		return false, err
	}
	s.seen[ip] = s.now()
	return true, nil
}

func (s *RouteSet) evictOldestLocked() {
	var oldest netip.Addr
	var at time.Time
	for ip, t := range s.seen {
		if !oldest.IsValid() || t.Before(at) {
			oldest, at = ip, t
		}
	}
	if oldest.IsValid() {
		_ = s.router.Release(oldest)
		delete(s.seen, oldest)
	}
}

// Expire drops the routes nothing has asked for within the TTL. It returns how many went.
func (s *RouteSet) Expire() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	cutoff := s.now().Add(-s.ttl)
	n := 0
	for ip, t := range s.seen {
		if t.Before(cutoff) {
			_ = s.router.Release(ip)
			delete(s.seen, ip)
			n++
		}
	}
	return n
}

// Len is how many addresses are diverted now.
func (s *RouteSet) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.seen)
}

// Addrs lists them (the platforms re-add them after the physical gateway changes).
func (s *RouteSet) Addrs() []netip.Addr {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]netip.Addr, 0, len(s.seen))
	for ip := range s.seen {
		out = append(out, ip)
	}
	return out
}

// Close releases everything. Best effort: one failing route must not keep the others in place.
func (s *RouteSet) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for ip := range s.seen {
		_ = s.router.Release(ip)
		delete(s.seen, ip)
	}
}
