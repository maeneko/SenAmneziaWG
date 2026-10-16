package proto

import (
	"strings"
	"testing"
)

func rules(rs ...RoutingRule) *Routing { return &Routing{Final: FinalProxy, Rules: rs} }

func TestValidateRoutingAccepts(t *testing.T) {
	ok := &Request{
		Routing: &Routing{Final: FinalDirect, Rules: []RoutingRule{
			{ActionProxy, KindSuffix, "example.com"},
			{ActionProxy, KindDomain, "nura.eco"},
			{ActionDirect, KindKeyword, "bank"},
			{ActionDirect, KindRegex, `^cdn[0-9]+\.example\.com$`},
			{ActionBlock, KindIP, "10.0.0.0/8"},
			{ActionBlock, KindIP, "2001:db8::/32"},
			{ActionProxy, KindIP, "93.184.216.34"},
			{ActionProxy, KindProcessName, "spotify"},
			{ActionProxy, KindProcessName, "Google Chrome"},
			{ActionDirect, KindProcessPath, "/usr/bin/telegram-desktop"},
		}},
		Dns: []string{"10.8.1.1"},
	}
	if err := ValidateRouting(ok); err != nil {
		t.Fatalf("valid routing refused: %v", err)
	}
	if err := ValidateRouting(&Request{}); err != nil {
		t.Fatalf("no routing must pass: %v", err)
	}
}

func TestValidateRoutingRefuses(t *testing.T) {
	many := make([]RoutingRule, MaxRoutingRules+1)
	for i := range many {
		many[i] = RoutingRule{ActionProxy, KindSuffix, "a" + strings.Repeat("b", i%5) + ".example.com"}
	}
	r := func(rule RoutingRule) *Request { return &Request{Routing: rules(rule)} }
	cases := map[string]*Request{
		"final":         {Routing: &Routing{Final: "off", Rules: []RoutingRule{{ActionProxy, KindSuffix, "example.com"}}}},
		"empty":         {Routing: &Routing{Final: FinalProxy}},
		"too many":      {Routing: &Routing{Final: FinalProxy, Rules: many}},
		"action":        r(RoutingRule{"reject", KindSuffix, "example.com"}),
		"kind":          r(RoutingRule{ActionProxy, "port", "443"}),
		"name path":     r(RoutingRule{ActionProxy, KindProcessName, "/usr/bin/spotify"}),
		"name empty":    r(RoutingRule{ActionProxy, KindProcessName, ""}),
		"name control":  r(RoutingRule{ActionProxy, KindProcessName, "a\nb"}),
		"path relative": r(RoutingRule{ActionProxy, KindProcessPath, "spotify"}),
		"path control":  r(RoutingRule{ActionProxy, KindProcessPath, "/usr/bin/a\x00b"}),
		"ruleset":       r(RoutingRule{ActionProxy, "ruleset", "geoip-ru"}),
		"bad domain":    r(RoutingRule{ActionProxy, KindSuffix, "a;b.com"}),
		"upper domain":  r(RoutingRule{ActionProxy, KindDomain, "Example.com"}),
		"short keyword": r(RoutingRule{ActionProxy, KindKeyword, "a"}),
		"keyword chars": r(RoutingRule{ActionProxy, KindKeyword, "a b"}),
		"bad regex":     r(RoutingRule{ActionProxy, KindRegex, "("}),
		"lookahead":     r(RoutingRule{ActionProxy, KindRegex, "(?=a)b"}),
		"long regex":    r(RoutingRule{ActionProxy, KindRegex, strings.Repeat("a", maxRegexLen+1)}),
		"control regex": r(RoutingRule{ActionProxy, KindRegex, "a\nb"}),
		"default route": r(RoutingRule{ActionBlock, KindIP, "0.0.0.0/0"}),
		"wide v4":       r(RoutingRule{ActionBlock, KindIP, "10.0.0.0/7"}),
		"wide v6":       r(RoutingRule{ActionBlock, KindIP, "2000::/8"}),
		"not an ip":     r(RoutingRule{ActionBlock, KindIP, "example.com"}),
		"zoned":         r(RoutingRule{ActionBlock, KindIP, "fe80::1%en0"}),
		"bad dns":       {Routing: rules(RoutingRule{ActionProxy, KindSuffix, "example.com"}), Dns: []string{"nope"}},
	}
	for name, req := range cases {
		if ValidateRouting(req) == nil {
			t.Errorf("%s: want refused", name)
		}
	}
}

func TestParseRuleIP(t *testing.T) {
	for in, want := range map[string]string{
		"10.1.2.3/8":    "10.0.0.0/8", // masked
		"93.184.216.34": "93.184.216.34/32",
		"2001:db8::1":   "2001:db8::1/128",
	} {
		p, err := ParseRuleIP(in)
		if err != nil || p.String() != want {
			t.Errorf("%q: %v %v, want %s", in, p, err, want)
		}
	}
}

// A 0.8.1–0.8.3 app sends `split`: it keeps working against this service.
func TestNormalizeRoutingFromLegacySplit(t *testing.T) {
	inc := &Request{Split: &Split{Mode: SplitInclude, Domains: []string{"example.com"}}}
	inc.NormalizeRouting()
	if inc.Routing == nil || inc.Routing.Final != FinalDirect || inc.Routing.Rules[0] != (RoutingRule{ActionProxy, KindSuffix, "example.com"}) {
		t.Fatalf("include: %+v", inc.Routing)
	}
	exc := &Request{Split: &Split{Mode: SplitExclude, Domains: []string{"example.com"}}}
	exc.NormalizeRouting()
	if exc.Routing.Final != FinalProxy || exc.Routing.Rules[0].Action != ActionDirect {
		t.Fatalf("exclude: %+v", exc.Routing)
	}
	if ValidateRouting(exc) != nil || ValidateRouting(inc) != nil {
		t.Fatal("converted routing must validate")
	}
	bad := &Request{Split: &Split{Mode: "weird", Domains: []string{"example.com"}}}
	bad.NormalizeRouting()
	if ValidateRouting(bad) == nil {
		t.Fatal("an unknown legacy mode must be refused")
	}
	// Routing wins when both are present.
	both := &Request{Routing: rules(RoutingRule{ActionBlock, KindSuffix, "x.com"}), Split: &Split{Mode: SplitInclude, Domains: []string{"y.com"}}}
	both.NormalizeRouting()
	if both.Routing.Rules[0].Value != "x.com" {
		t.Fatal("routing must supersede split")
	}
}
