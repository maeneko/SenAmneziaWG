package proto

import "regexp"

// Split modes: which of the two lists the domains are.
const (
	SplitInclude = "include" // only the listed names go through the tunnel
	SplitExclude = "exclude" // everything but the listed names goes through the tunnel
)

// Split is what 0.8.1–0.8.3 sent: one mode and a list of sites. Only read now (NormalizeRouting turns it into Routing).
type Split struct {
	Mode    string   `json:"mode"`
	Domains []string `json:"domains"`
}

// domainPattern: what the app's normalizeDomain produces — lower-case ASCII (punycode for the rest),
// at least two labels, no label starting or ending with a hyphen. Anything else never reaches the matcher.
var domainPattern = regexp.MustCompile(`^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)

// ValidDomain reports whether name is a domain in the form the app sends.
func ValidDomain(name string) bool {
	if len(name) > 253 || !domainPattern.MatchString(name) {
		return false
	}
	// "1.2.3.4" is an address, not a name: the proxy would never see it asked for.
	last := name[lastDot(name)+1:]
	for _, r := range last {
		if r < '0' || r > '9' {
			return true
		}
	}
	return false
}

func lastDot(s string) int {
	for i := len(s) - 1; i >= 0; i-- {
		if s[i] == '.' {
			return i
		}
	}
	return -1
}
