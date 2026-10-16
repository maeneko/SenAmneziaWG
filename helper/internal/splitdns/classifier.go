package splitdns

import (
	"fmt"
	"regexp"
	"strings"
)

// Action is what a name's rule says; the order is the order rules are matched in (the first match wins).
type Action int

const (
	ActProxy Action = iota + 1
	ActDirect
	ActBlock
)

func (a Action) String() string {
	switch a {
	case ActProxy:
		return "через туннель"
	case ActDirect:
		return "напрямую"
	case ActBlock:
		return "блок"
	}
	return "?"
}

// Rule is one line of the user's lists, in the words of proto.RoutingRule (this package does not import proto).
type Rule struct {
	Action Action
	Kind   string // domain, suffix, keyword, regex; anything else is not about names and is skipped
	Value  string
}

type nameSet struct {
	exact    map[string]struct{}
	suffix   *Matcher
	suffixes []string
	keywords []string
	regexes  []*regexp.Regexp
}

func (s *nameSet) match(name string) bool {
	if _, ok := s.exact[name]; ok {
		return true
	}
	if s.suffix != nil && s.suffix.Match(name) {
		return true
	}
	for _, k := range s.keywords {
		if strings.Contains(name, k) {
			return true
		}
	}
	for _, re := range s.regexes {
		if re.MatchString(name) {
			return true
		}
	}
	return false
}

type group struct {
	action Action
	set    nameSet
}

// Classifier tells which rule a DNS name falls under. The first matching rule wins, in the order the rules
// came: a run of neighbouring rules with the same action is one group (so thousands of names are matched by
// one trie, not one rule at a time), and the groups are tried in sequence. The app sends proxy, direct, block
// for the simple lists (Throne's order) and the user's own order for the advanced rules.
type Classifier struct {
	groups []group
	count  int
}

// NewClassifier compiles the rules. A regular expression that does not compile is an error: the request was
// checked already, so this only ever fails for a state file written by something else.
func NewClassifier(rules []Rule) (*Classifier, error) {
	c := &Classifier{}
	for _, r := range rules {
		if r.Action < ActProxy || r.Action > ActBlock {
			continue
		}
		switch r.Kind {
		case "domain", "suffix", "keyword", "regex":
		default:
			continue // not about names (an `ip` rule): the routers' business, and no break in a run
		}
		if n := len(c.groups); n == 0 || c.groups[n-1].action != r.Action {
			c.groups = append(c.groups, group{action: r.Action})
		}
		s := &c.groups[len(c.groups)-1].set
		switch r.Kind {
		case "domain":
			if s.exact == nil {
				s.exact = map[string]struct{}{}
			}
			s.exact[r.Value] = struct{}{}
		case "suffix":
			s.suffixes = append(s.suffixes, r.Value)
		case "keyword":
			s.keywords = append(s.keywords, r.Value)
		case "regex":
			re, err := regexp.Compile(r.Value)
			if err != nil {
				return nil, fmt.Errorf("регулярное выражение %q: %w", r.Value, err)
			}
			s.regexes = append(s.regexes, re)
		}
		c.count++
	}
	for i := range c.groups {
		if len(c.groups[i].set.suffixes) > 0 {
			c.groups[i].set.suffix = NewMatcher(c.groups[i].set.suffixes)
		}
	}
	return c, nil
}

// Len is how many name rules there are.
func (c *Classifier) Len() int { return c.count }

// Classify returns the action of the first rule that matches name (lower case, no trailing dot).
func (c *Classifier) Classify(name string) (Action, bool) {
	for i := range c.groups {
		if c.groups[i].set.match(name) {
			return c.groups[i].action, true
		}
	}
	return 0, false
}
