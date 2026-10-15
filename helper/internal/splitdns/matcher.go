// Package splitdns decides, per DNS question, which way traffic to a name should go. It runs a small
// DNS proxy: the system's resolver is pointed at it, it answers every question from the right upstream
// (the tunnel's DNS or the system's own) and, for the names the user listed, routes the addresses of the
// answer the other way than the default one before it hands the answer back. It imports nothing
// platform-specific: each platform supplies a Router (route commands) and a dialer (a socket bound to
// the physical network), so the logic is built and tested everywhere, like internal/proto.
package splitdns

import "strings"

// Matcher answers «is this name, or one of its parents, in the list».
type Matcher struct{ root *node }

type node struct {
	children map[string]*node
	end      bool
}

// NewMatcher builds the matcher from names in the form proto.ValidDomain accepts.
func NewMatcher(domains []string) *Matcher {
	m := &Matcher{root: &node{}}
	for _, d := range domains {
		n := m.root
		labels := strings.Split(d, ".")
		for i := len(labels) - 1; i >= 0; i-- {
			if n.children == nil {
				n.children = map[string]*node{}
			}
			next := n.children[labels[i]]
			if next == nil {
				next = &node{}
				n.children[labels[i]] = next
			}
			n = next
		}
		n.end = true
	}
	return m
}

// Match reports whether name (lower case, no trailing dot) is a listed name or a subdomain of one.
// «badexample.com» is not a subdomain of «example.com»: the walk goes label by label.
func (m *Matcher) Match(name string) bool {
	n := m.root
	labels := strings.Split(name, ".")
	for i := len(labels) - 1; i >= 0; i-- {
		n = n.children[labels[i]]
		if n == nil {
			return false
		}
		if n.end {
			return true
		}
	}
	return false
}
