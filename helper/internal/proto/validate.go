package proto

import (
	"encoding/base64"
	"fmt"
	"net/netip"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

// MaxConf is far above any real config (a few hundred bytes) and small enough to reject junk cheaply.
const MaxConf = 16 * 1024

var (
	idPattern       = regexp.MustCompile(`^[0-9A-Za-z-]{1,64}$`)
	headerPattern   = regexp.MustCompile(`^\d{1,10}(-\d{1,10})?$`)
	digitsPattern   = regexp.MustCompile(`^\d{1,10}$`)
	togglePattern   = regexp.MustCompile(`(?i)^(on|off|1|0|true|false)$`)
	iPacketPattern  = regexp.MustCompile(`^[\x20-\x7e]{1,1000}$`)
	hostnamePattern = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$`)
)

// ValidateUp is the security boundary of the whole helper. The pipe lets an unprivileged user make a
// SYSTEM service write a file and start a service, so nothing they send may name a path, an
// executable, a service or an adapter: those are constants of the helper. What they do send is a
// .conf, and it is accepted only if every line is a known key with a value of the expected shape.
func ValidateUp(req *Request) *Error {
	if !idPattern.MatchString(req.ID) {
		return Errf(CodeBadRequest, "Некорректный идентификатор туннеля")
	}
	if len(req.Name) > 256 { // bytes: a Cyrillic letter takes two
		return Errf(CodeBadRequest, "Слишком длинное имя туннеля")
	}
	if len(req.Conf) == 0 || len(req.Conf) > MaxConf {
		return Errf(CodeConfInvalid, "Конфигурация туннеля пуста или слишком велика")
	}
	if err := ValidateConf(req.Conf); err != nil {
		return Errf(CodeConfInvalid, "Конфигурация туннеля отклонена: "+err.Error())
	}
	return nil
}

// SafeName makes a user-supplied tunnel name printable in the log.
func SafeName(name string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, name)
}

type rule struct {
	check    func(string) error
	required bool
}

func required(check func(string) error) rule { return rule{check: check, required: true} }
func optional(check func(string) error) rule { return rule{check: check} }

// Keys are the ones the app writes (see buildWgConf). Anything else — PostUp, Table, ListenPort, a key
// from a future protocol generation — is refused here rather than handed to the tunnel service.
var interfaceRules = map[string]rule{
	"privatekey":             required(base64Key),
	"address":                required(prefixList),
	"dns":                    optional(ipList),
	"mtu":                    optional(intRange(576, 9000)),
	"jc":                     optional(intRange(0, 65535)),
	"jmin":                   optional(intRange(0, 65535)),
	"jmax":                   optional(intRange(0, 65535)),
	"s1":                     optional(intRange(0, 65535)),
	"s2":                     optional(intRange(0, 65535)),
	"s3":                     optional(intRange(0, 65535)),
	"s4":                     optional(intRange(0, 65535)),
	"h1":                     optional(match(headerPattern, "диапазон чисел")),
	"h2":                     optional(match(headerPattern, "диапазон чисел")),
	"h3":                     optional(match(headerPattern, "диапазон чисел")),
	"h4":                     optional(match(headerPattern, "диапазон чисел")),
	"i1":                     optional(match(iPacketPattern, "печатный ASCII")),
	"i2":                     optional(match(iPacketPattern, "печатный ASCII")),
	"i3":                     optional(match(iPacketPattern, "печатный ASCII")),
	"i4":                     optional(match(iPacketPattern, "печатный ASCII")),
	"i5":                     optional(match(iPacketPattern, "печатный ASCII")),
	"headerprotectionkey":    optional(base64Key),
	"contentpaddingaddition": optional(match(digitsPattern, "число")),
	"rekeyaftertime":         optional(match(digitsPattern, "число")),
	"rekeytimeout":           optional(match(digitsPattern, "число")),
	"rejectaftertime":        optional(match(digitsPattern, "число")),
	"keepalivetimeout":       optional(match(digitsPattern, "число")),
	"maxhandshakeattempts":   optional(match(digitsPattern, "число")),
	"randomtrailers":         optional(match(togglePattern, "on/off")),
	"disablecookies":         optional(match(togglePattern, "on/off")),
}

var peerRules = map[string]rule{
	"publickey":           required(base64Key),
	"presharedkey":        optional(base64Key),
	"allowedips":          required(prefixList),
	"endpoint":            required(endpoint),
	"persistentkeepalive": optional(intRange(0, 65535)),
}

// ValidateConf accepts exactly one [Interface] and one [Peer] section.
func ValidateConf(text string) error {
	seen := map[string]map[string]bool{"interface": {}, "peer": {}}
	sections := map[string]int{}
	var rules map[string]rule
	var section string

	for n, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		where := fmt.Sprintf("строка %d", n+1)
		if strings.ContainsRune(line, '#') {
			return fmt.Errorf("%s: комментарии не допускаются", where)
		}
		if strings.HasPrefix(line, "[") {
			switch strings.ToLower(line) {
			case "[interface]":
				section, rules = "interface", interfaceRules
			case "[peer]":
				section, rules = "peer", peerRules
			default:
				return fmt.Errorf("%s: неизвестная секция", where)
			}
			sections[section]++
			if sections[section] > 1 {
				return fmt.Errorf("%s: секция повторяется", where)
			}
			continue
		}
		if rules == nil {
			return fmt.Errorf("%s: строка вне секции", where)
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			return fmt.Errorf("%s: нет знака =", where)
		}
		key, value = strings.ToLower(strings.TrimSpace(key)), strings.TrimSpace(value)
		r, known := rules[key]
		if !known {
			return fmt.Errorf("%s: недопустимый ключ", where)
		}
		if seen[section][key] {
			return fmt.Errorf("%s: ключ повторяется", where)
		}
		seen[section][key] = true
		if err := r.check(value); err != nil {
			return fmt.Errorf("%s: %w", where, err)
		}
	}

	for _, sec := range []struct {
		name, title string
		rules       map[string]rule
	}{{"interface", "Interface", interfaceRules}, {"peer", "Peer", peerRules}} {
		if sections[sec.name] != 1 {
			return fmt.Errorf("нужна ровно одна секция [%s]", sec.title)
		}
		for key, r := range sec.rules {
			if r.required && !seen[sec.name][key] {
				return fmt.Errorf("в секции [%s] нет обязательного ключа %s", sec.title, key)
			}
		}
	}
	return nil
}

func match(re *regexp.Regexp, what string) func(string) error {
	return func(v string) error {
		if !re.MatchString(v) {
			return fmt.Errorf("ожидается %s", what)
		}
		return nil
	}
}

func intRange(lo, hi int) func(string) error {
	return func(v string) error {
		n, err := strconv.Atoi(v)
		if err != nil || n < lo || n > hi {
			return fmt.Errorf("ожидается число от %d до %d", lo, hi)
		}
		return nil
	}
}

func base64Key(v string) error {
	b, err := base64.StdEncoding.DecodeString(v)
	if err != nil || len(b) != 32 {
		return fmt.Errorf("ключ должен быть 32 байта в base64")
	}
	return nil
}

func list(v string, each func(string) error) error {
	items := strings.Split(v, ",")
	if len(items) > 32 {
		return fmt.Errorf("слишком много элементов")
	}
	for _, item := range items {
		if err := each(strings.TrimSpace(item)); err != nil {
			return err
		}
	}
	return nil
}

func ipList(v string) error {
	return list(v, func(s string) error {
		if _, err := netip.ParseAddr(s); err != nil {
			return fmt.Errorf("%q не IP-адрес", s)
		}
		return nil
	})
}

// An address or an allowed range; a bare address means a single host.
func prefixList(v string) error {
	return list(v, func(s string) error {
		if strings.Contains(s, "/") {
			if _, err := netip.ParsePrefix(s); err != nil {
				return fmt.Errorf("%q не сеть в формате CIDR", s)
			}
			return nil
		}
		if _, err := netip.ParseAddr(s); err != nil {
			return fmt.Errorf("%q не IP-адрес", s)
		}
		return nil
	})
}

func endpoint(v string) error {
	var host, port string
	if strings.HasPrefix(v, "[") {
		end := strings.Index(v, "]:")
		if end < 0 {
			return fmt.Errorf("ожидается [адрес]:порт")
		}
		host, port = v[1:end], v[end+2:]
		if a, err := netip.ParseAddr(host); err != nil || !a.Is6() {
			return fmt.Errorf("в скобках ожидается IPv6-адрес")
		}
	} else {
		i := strings.LastIndex(v, ":")
		if i < 0 {
			return fmt.Errorf("ожидается адрес:порт")
		}
		host, port = v[:i], v[i+1:]
		if a, err := netip.ParseAddr(host); err == nil {
			if !a.Is4() {
				return fmt.Errorf("IPv6-адрес нужно писать в квадратных скобках")
			}
		} else if !hostnamePattern.MatchString(host) {
			return fmt.Errorf("недопустимое имя сервера")
		}
	}
	if p, err := strconv.Atoi(port); err != nil || p < 1 || p > 65535 {
		return fmt.Errorf("порт должен быть от 1 до 65535")
	}
	return nil
}
