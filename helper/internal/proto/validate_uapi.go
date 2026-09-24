package proto

import (
	"strconv"
	"strings"
)

// MaxUAPI bounds the body ValidateUAPI accepts: generous for one interface and one peer, small enough
// to reject junk cheaply.
const MaxUAPI = 16 * 1024

// deviceUAPIRules and peerUAPIRules are the UAPI counterpart of interfaceRules/peerRules (validate.go):
// same idea, same security boundary, different wire format. src/main/tunnel/uapiConfig.ts is the only
// writer of this body (macOS and Linux both send it, straight to the daemon's UAPI socket or library
// call), so the keys and shapes here must track buildUapiSet exactly.
var deviceUAPIRules = map[string]rule{
	"private_key":              required(hexKey),
	"jc":                       optional(intRange(0, 65535)),
	"jmin":                     optional(intRange(0, 65535)),
	"jmax":                     optional(intRange(0, 65535)),
	"s1":                       optional(intRange(0, 65535)),
	"s2":                       optional(intRange(0, 65535)),
	"s3":                       optional(intRange(0, 65535)),
	"s4":                       optional(intRange(0, 65535)),
	"h1":                       optional(match(rangePattern, "диапазон чисел")),
	"h2":                       optional(match(rangePattern, "диапазон чисел")),
	"h3":                       optional(match(rangePattern, "диапазон чисел")),
	"h4":                       optional(match(rangePattern, "диапазон чисел")),
	"i1":                       optional(match(iPacketPattern, "печатный ASCII")),
	"i2":                       optional(match(iPacketPattern, "печатный ASCII")),
	"i3":                       optional(match(iPacketPattern, "печатный ASCII")),
	"i4":                       optional(match(iPacketPattern, "печатный ASCII")),
	"i5":                       optional(match(iPacketPattern, "печатный ASCII")),
	"header_protection_key":    optional(hexKey),
	"content_padding_addition": optional(match(rangePattern, "число или диапазон")),
	"rekey_after_time":         optional(match(rangePattern, "число или диапазон")),
	"rekey_timeout":            optional(match(rangePattern, "число или диапазон")),
	"reject_after_time":        optional(match(rangePattern, "число или диапазон")),
	"keepalive_timeout":        optional(match(rangePattern, "число или диапазон")),
	"max_handshake_attempts":   optional(match(rangePattern, "число или диапазон")),
	"random_trailers":          optional(match(togglePattern, "on/off")),
	"disable_cookies":          optional(match(togglePattern, "on/off")),
}

var deviceUAPIFixed = map[string]string{"replace_peers": "true"}

var peerUAPIRules = map[string]rule{
	"public_key":                    required(hexKey),
	"preshared_key":                 optional(hexKey),
	"endpoint":                      required(endpoint),
	"persistent_keepalive_interval": optional(intRange(0, 65535)),
}

var peerUAPIFixed = map[string]string{"replace_allowed_ips": "true"}

func hexKey(v string) error {
	if len(v) != 64 {
		return errHex
	}
	for _, r := range v {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F')) {
			return errHex
		}
	}
	return nil
}

var errHex = matchErr("ключ должен быть 32 байта в hex")

type matchErr string

func (e matchErr) Error() string { return string(e) }

// ValidateUAPI accepts exactly the shape buildUapiSet produces: `set=1`, the device's own keys (private
// key first, replace_peers fixed), one `allowed_ip=` or more after the peer's own keys, ending with
// replace_allowed_ips. Nothing else — no path, no executable, no second peer — is let through to the
// daemon, since this body is programmed straight into it (device.IpcSet), with no shell or service
// manager in between to sandbox a mistake.
func ValidateUAPI(text string) error {
	lines := strings.Split(strings.TrimRight(text, "\n"), "\n")
	if len(lines) == 0 || lines[0] != "set=1" {
		return matchErr("ожидается set=1 первой строкой")
	}
	lines = lines[1:]

	i, seenDevice, err := consumeSection(lines, deviceUAPIRules, deviceUAPIFixed, "public_key")
	if err != nil {
		return err
	}
	for key := range deviceUAPIFixed {
		if !seenDevice[key] {
			return matchErr("нет обязательного ключа " + key)
		}
	}
	if !seenDevice["private_key"] {
		return matchErr("нет обязательного ключа private_key")
	}

	rest := lines[i:]
	if len(rest) == 0 || !strings.HasPrefix(rest[0], "public_key=") {
		return matchErr("ожидается public_key — начало секции пира")
	}
	j, seenPeer, err := consumeSection(rest, peerUAPIRules, peerUAPIFixed, "allowed_ip")
	if err != nil {
		return err
	}
	for _, key := range []string{"public_key", "endpoint"} {
		if !seenPeer[key] {
			return matchErr("нет обязательного ключа " + key)
		}
	}
	for key := range peerUAPIFixed {
		if !seenPeer[key] {
			return matchErr("нет обязательного ключа " + key)
		}
	}

	allowedIPs := 0
	for _, l := range rest[j:] {
		if l == "" {
			continue
		}
		key, value, ok := strings.Cut(l, "=")
		if !ok || key != "allowed_ip" {
			return matchErr("после параметров пира ожидаются только allowed_ip")
		}
		if err := prefixList(value); err != nil {
			return err
		}
		allowedIPs++
		if allowedIPs > 32 {
			return matchErr("слишком много allowed_ip")
		}
	}
	if allowedIPs == 0 {
		return matchErr("нужен хотя бы один allowed_ip")
	}
	return nil
}

// consumeSection reads key=value lines that satisfy rules or match one of fixed exactly, until a line
// starting with stopAt (if not empty) or the input ends. It rejects any key repeated or not recognised.
func consumeSection(lines []string, rules map[string]rule, fixed map[string]string, stopAt string) (int, map[string]bool, error) {
	seen := map[string]bool{}
	i := 0
	for ; i < len(lines); i++ {
		l := lines[i]
		if l == "" {
			continue
		}
		if stopAt != "" && strings.HasPrefix(l, stopAt+"=") {
			break
		}
		key, value, ok := strings.Cut(l, "=")
		if !ok {
			return 0, nil, matchErr("нет знака = в " + l)
		}
		if seen[key] {
			return 0, nil, matchErr("ключ повторяется: " + key)
		}
		if want, isFixed := fixed[key]; isFixed {
			if value != want {
				return 0, nil, matchErr(key + " должен быть " + want)
			}
			seen[key] = true
			continue
		}
		r, known := rules[key]
		if !known {
			return 0, nil, matchErr("недопустимый ключ: " + key)
		}
		if err := r.check(value); err != nil {
			return 0, nil, err
		}
		seen[key] = true
	}
	return i, seen, nil
}

// ValidateUpUAPI is ValidateUp's counterpart for the UAPI body the macOS and Linux backends send
// (see uapiConfig.ts): same request-level checks, ValidateUAPI in place of ValidateConf.
func ValidateUpUAPI(req *Request) *Error {
	if !idPattern.MatchString(req.ID) {
		return Errf(CodeBadRequest, "Некорректный идентификатор туннеля")
	}
	if len(req.Name) > 256 {
		return Errf(CodeBadRequest, "Слишком длинное имя туннеля")
	}
	if len(req.Conf) == 0 || len(req.Conf) > MaxUAPI {
		return Errf(CodeConfInvalid, "Конфигурация туннеля пуста или слишком велика")
	}
	if err := ValidateUAPI(req.Conf); err != nil {
		return Errf(CodeConfInvalid, "Конфигурация туннеля отклонена: "+err.Error())
	}
	if len(req.Address) == 0 || len(req.Address) > 32 {
		return Errf(CodeConfInvalid, "Некорректный адрес туннеля")
	}
	for _, a := range req.Address {
		if err := prefixList(a); err != nil {
			return Errf(CodeConfInvalid, "Некорректный адрес туннеля: "+err.Error())
		}
	}
	if req.Mtu != 0 {
		if err := intRange(576, 9000)(strconv.Itoa(req.Mtu)); err != nil {
			return Errf(CodeConfInvalid, "Некорректный MTU")
		}
	}
	if len(req.Dns) > 8 {
		return Errf(CodeConfInvalid, "Слишком много DNS-серверов")
	}
	for _, s := range req.Dns {
		if err := ipList(s); err != nil {
			return Errf(CodeConfInvalid, "Некорректный DNS-сервер: "+err.Error())
		}
	}
	return nil
}
