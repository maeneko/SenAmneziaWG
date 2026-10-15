package proto

import (
	"strings"
	"testing"
)

func TestValidDomain(t *testing.T) {
	good := []string{"example.com", "a.b.example.co.uk", "xn--80ak6aa92e.com", "my-site.ru", "1c.ru"}
	bad := []string{"", "com", "1.2.3.4", "-a.com", "a-.com", "a..com", "Example.com", "a.com/x", "a b.com", "a.com.", "*.a.com",
		strings.Repeat("a", 64) + ".com", strings.Repeat("a.", 130) + "com", "a.com\n", "пример.рф"}
	for _, d := range good {
		if !ValidDomain(d) {
			t.Errorf("%q: want valid", d)
		}
	}
	for _, d := range bad {
		if ValidDomain(d) {
			t.Errorf("%q: want invalid", d)
		}
	}
}

func TestValidateSplit(t *testing.T) {
	ok := &Request{Split: &Split{Mode: SplitExclude, Domains: []string{"example.com"}}, Dns: []string{"10.8.1.1"}}
	if err := ValidateSplit(ok); err != nil {
		t.Fatalf("valid split refused: %v", err)
	}
	if err := ValidateSplit(&Request{}); err != nil {
		t.Fatalf("no split must pass: %v", err)
	}

	many := make([]string, MaxSplitDomains+1)
	for i := range many {
		many[i] = "a" + strings.Repeat("b", i%5) + ".example.com"
	}
	cases := map[string]*Request{
		"mode":     {Split: &Split{Mode: "off", Domains: []string{"example.com"}}},
		"empty":    {Split: &Split{Mode: SplitInclude}},
		"too many": {Split: &Split{Mode: SplitInclude, Domains: many}},
		"bad name": {Split: &Split{Mode: SplitInclude, Domains: []string{"example.com", "a;b.com"}}},
		"bad dns":  {Split: &Split{Mode: SplitInclude, Domains: []string{"example.com"}}, Dns: []string{"not-an-ip"}},
		"many dns": {Split: &Split{Mode: SplitInclude, Domains: []string{"example.com"}}, Dns: strings.Fields("1.1.1.1 1.1.1.2 1.1.1.3 1.1.1.4 1.1.1.5 1.1.1.6 1.1.1.7 1.1.1.8 1.1.1.9")},
	}
	for name, req := range cases {
		if ValidateSplit(req) == nil {
			t.Errorf("%s: want refused", name)
		}
	}
}
