package proto

import (
	"fmt"
	"net/netip"
	"regexp"
	"strings"
	"unicode"
)

// «Маршрутизация»: the default and the ordered rules the app sends with `up` (src/shared/routingRules.ts
// writes them; the checks here repeat that file's, because the request comes from an unprivileged process and
// its values reach a DNS matcher, regular-expression compiler and routing commands of a root service).

const (
	ActionProxy  = "proxy"
	ActionDirect = "direct"
	ActionBlock  = "block"

	FinalProxy  = "proxy"
	FinalDirect = "direct"

	KindDomain  = "domain"
	KindSuffix  = "suffix"
	KindKeyword = "keyword"
	KindRegex   = "regex"
	KindIP      = "ip"

	// Rules about programs: Linux only (perapp_linux.go).
	KindProcessName = "processName"
	KindProcessPath = "processPath"
)

const (
	MaxRoutingRules = 2000
	// MaxSplitBytes bounds the rules as a whole.
	MaxSplitBytes = 128 * 1024
	maxRegexLen   = 256

	// The shortest networks an `ip:` rule may name: /0 or /1 would override the whole routing table.
	minPrefixV4 = 8
	minPrefixV6 = 16
)

// RoutingRule is one line of one of the three lists.
type RoutingRule struct {
	Action string `json:"action"`
	Kind   string `json:"kind"`
	Value  string `json:"value"`
}

// Routing is the whole configuration: what happens to everything no rule names, then the rules in the order
// they are matched (proxy, direct, block: the first match wins).
type Routing struct {
	Final string        `json:"final"`
	Rules []RoutingRule `json:"rules"`
}

var keywordPattern = regexp.MustCompile(`^[a-z0-9._-]{2,63}$`)

// NormalizeRouting turns the 0.8.x request (`split`: one mode and a list of sites) into the same thing:
// «only the list» is a default of direct with the sites as proxy, «all but the list» a default of proxy with
// the sites as direct. A newer service therefore still serves an older app.
func (r *Request) NormalizeRouting() {
	if r.Routing != nil || r.Split == nil {
		return
	}
	out := &Routing{}
	action := ActionDirect
	switch r.Split.Mode {
	case SplitInclude:
		out.Final, action = FinalDirect, ActionProxy
	case SplitExclude:
		out.Final = FinalProxy
	}
	for _, d := range r.Split.Domains {
		out.Rules = append(out.Rules, RoutingRule{Action: action, Kind: KindSuffix, Value: d})
	}
	r.Routing = out
}

// ParseRuleIP reads the value of an `ip` rule: an address (one host) or a network, as the network.
func ParseRuleIP(value string) (netip.Prefix, error) {
	if p, err := netip.ParsePrefix(value); err == nil {
		min := minPrefixV4
		if p.Addr().Is6() && !p.Addr().Is4In6() {
			min = minPrefixV6
		}
		if p.Addr().Is4In6() {
			return netip.Prefix{}, fmt.Errorf("адрес IPv4 в записи IPv6")
		}
		if p.Bits() < min {
			return netip.Prefix{}, fmt.Errorf("сеть слишком широкая: длина не меньше %d", min)
		}
		return p.Masked(), nil
	}
	a, err := netip.ParseAddr(value)
	if err != nil || a.Zone() != "" || a.Is4In6() {
		return netip.Prefix{}, fmt.Errorf("не IP-адрес и не сеть")
	}
	return netip.PrefixFrom(a, a.BitLen()), nil
}

// ValidateRouting checks the optional routing of an `up`. Dns is checked here too, because with routing it is
// where the helper sends the tunnel's own queries.
func ValidateRouting(req *Request) *Error {
	r := req.Routing
	if r == nil {
		return nil
	}
	if r.Final != FinalProxy && r.Final != FinalDirect {
		return Errf(CodeBadRequest, "Некорректное действие по умолчанию")
	}
	if len(r.Rules) == 0 || len(r.Rules) > MaxRoutingRules {
		return Errf(CodeBadRequest, "Некорректное число правил маршрутизации")
	}
	total := 0
	for _, rule := range r.Rules {
		if rule.Action != ActionProxy && rule.Action != ActionDirect && rule.Action != ActionBlock {
			return Errf(CodeBadRequest, "Некорректное действие правила")
		}
		if err := validateRule(rule); err != nil {
			return Errf(CodeBadRequest, "Правило «"+SafeName(rule.Kind)+":"+SafeName(truncate(rule.Value, 60))+"»: "+err.Error())
		}
		total += len(rule.Value)
	}
	if total > MaxSplitBytes {
		return Errf(CodeBadRequest, "Правила маршрутизации слишком велики")
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

func validateRule(rule RoutingRule) error {
	switch rule.Kind {
	case KindDomain, KindSuffix:
		if !ValidDomain(rule.Value) {
			return fmt.Errorf("не доменное имя")
		}
	case KindKeyword:
		if !keywordPattern.MatchString(rule.Value) {
			return fmt.Errorf("ключевое слово: 2–63 символа a–z, 0–9, точка, дефис, подчёркивание")
		}
	case KindRegex:
		if rule.Value == "" || len(rule.Value) > maxRegexLen {
			return fmt.Errorf("регулярное выражение: до %d символов", maxRegexLen)
		}
		if hasControl(rule.Value) {
			return fmt.Errorf("в регулярном выражении управляющий символ")
		}
		if _, err := regexp.Compile(rule.Value); err != nil {
			return fmt.Errorf("некорректное регулярное выражение")
		}
	case KindIP:
		if _, err := ParseRuleIP(rule.Value); err != nil {
			return err
		}
	case KindProcessName:
		if rule.Value == "" || len(rule.Value) > 255 || strings.ContainsAny(rule.Value, "/\\") || hasControl(rule.Value) {
			return fmt.Errorf("имя программы — имя файла без пути")
		}
	case KindProcessPath:
		if !strings.HasPrefix(rule.Value, "/") || len(rule.Value) > 4096 || hasControl(rule.Value) {
			return fmt.Errorf("путь к программе — полный, от корня")
		}
	default:
		return fmt.Errorf("этот вид правил служба не поддерживает")
	}
	return nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

func hasControl(s string) bool {
	for _, r := range s {
		if unicode.IsControl(r) {
			return true
		}
	}
	return false
}
