package proto

import (
	"net/netip"
	"regexp"
)

// Split modes: which of the two lists the domains are.
const (
	SplitInclude = "include" // only the listed names go through the tunnel
	SplitExclude = "exclude" // everything but the listed names goes through the tunnel
)

const (
	MaxSplitDomains = 500
	// MaxSplitBytes bounds the list as a whole; 500 names of the longest allowed size come to about 126 KB.
	MaxSplitBytes = 128 * 1024
)

// Split is the request's routing-by-name part (src/shared/uiSettings.ts: SplitConfig).
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

// ValidateSplit checks the optional split of an `up`. The list becomes arguments of routing commands on
// macOS and entries of the system's name resolution on Windows, so it is accepted only in the exact form
// the app produces. Dns is checked here too, because with a split it is where the helper sends queries.
func ValidateSplit(req *Request) *Error {
	s := req.Split
	if s == nil {
		return nil
	}
	if s.Mode != SplitInclude && s.Mode != SplitExclude {
		return Errf(CodeBadRequest, "Некорректный режим раздельного туннеля")
	}
	if len(s.Domains) == 0 || len(s.Domains) > MaxSplitDomains {
		return Errf(CodeBadRequest, "Некорректный список сайтов для раздельного туннеля")
	}
	total := 0
	for _, d := range s.Domains {
		if !ValidDomain(d) {
			return Errf(CodeBadRequest, "Некорректное имя сайта в списке раздельного туннеля")
		}
		total += len(d)
	}
	if total > MaxSplitBytes {
		return Errf(CodeBadRequest, "Список сайтов раздельного туннеля слишком велик")
	}
	if len(req.Dns) > 8 {
		return Errf(CodeConfInvalid, "Слишком много DNS-серверов")
	}
	for _, a := range req.Dns {
		if _, err := netip.ParseAddr(a); err != nil {
			return Errf(CodeConfInvalid, "Некорректный DNS-сервер")
		}
	}
	return nil
}

// ModeOrEmpty is the mode of a possibly absent split.
func (s *Split) ModeOrEmpty() string {
	if s == nil {
		return ""
	}
	return s.Mode
}
