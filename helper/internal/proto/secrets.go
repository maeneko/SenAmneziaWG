package proto

import (
	"encoding/base64"
	"encoding/hex"
	"errors"
	"regexp"
	"strings"
)

// ValidateSecretPut checks a secret-put request: a tunnel id that is safe as a file name (idPattern
// allows only letters, digits and '-') and keys in the .conf's own base64 form.
func ValidateSecretPut(req *Request) *Error {
	if err := ValidateSecretID(req); err != nil {
		return err
	}
	if base64Key(req.PrivateKey) != nil {
		return Errf(CodeBadRequest, "Некорректный закрытый ключ")
	}
	if req.PresharedKey != "" && base64Key(req.PresharedKey) != nil {
		return Errf(CodeBadRequest, "Некорректный общий ключ (PresharedKey)")
	}
	return nil
}

// ValidateSecretID checks the id secret-delete (and secret-put) name the keys by.
func ValidateSecretID(req *Request) *Error {
	if !idPattern.MatchString(req.ID) {
		return Errf(CodeBadRequest, "Некорректный идентификатор туннеля")
	}
	return nil
}

var (
	senIDPattern = regexp.MustCompile(`^sen-[0-9A-Za-z-]{1,60}$`)
	// METHOD \n /sub/v1/path \n unix seconds \n hex(sha256(body)) — docs/sen-link.md in the panel's repository.
	// Nothing else is signed: the service is not to become a general-purpose signing oracle.
	senMessagePattern = regexp.MustCompile(`^(GET|POST|PUT|DELETE)\n/sub/v1/[a-z/]{1,64}\n[0-9]{1,12}\n[0-9a-f]{64}$`)
)

// ValidateSenSign checks a sen-sign request: the id must be a subscription auth key's ("sen-…", which no
// tunnel id is allowed to be used for by the app), and the message the shape of a /sub/v1 request string.
func ValidateSenSign(req *Request) *Error {
	if !senIDPattern.MatchString(req.ID) {
		return Errf(CodeBadRequest, "Некорректный идентификатор ключа подписки")
	}
	if len(req.Message) > 256 || !senMessagePattern.MatchString(req.Message) {
		return Errf(CodeBadRequest, "Служба подписывает только запросы подписки")
	}
	return nil
}

var errHasSecret = errors.New("конфигурация уже содержит ключ")

// InjectSecrets puts the kept keys into a UAPI body the app sent without them, where buildUapiSet
// (src/main/tunnel/uapiConfig.ts) itself writes them: private_key right after `set=1`, preshared_key
// right after the peer's public_key. The result still goes through ValidateUAPI, so a body shaped any
// other way is rejected there rather than here.
func InjectSecrets(conf, privateKey, presharedKey string) (string, error) {
	priv, err := base64.StdEncoding.DecodeString(privateKey)
	if err != nil || len(priv) != 32 {
		return "", errors.New("сохранённый ключ повреждён")
	}
	var psk []byte
	if presharedKey != "" {
		if psk, err = base64.StdEncoding.DecodeString(presharedKey); err != nil || len(psk) != 32 {
			return "", errors.New("сохранённый ключ повреждён")
		}
	}
	lines := strings.Split(conf, "\n")
	out := make([]string, 0, len(lines)+2)
	for i, line := range lines {
		if strings.HasPrefix(line, "private_key=") || strings.HasPrefix(line, "preshared_key=") {
			return "", errHasSecret
		}
		out = append(out, line)
		if i == 0 && line == "set=1" {
			out = append(out, "private_key="+hex.EncodeToString(priv))
		}
		if psk != nil && strings.HasPrefix(line, "public_key=") {
			out = append(out, "preshared_key="+hex.EncodeToString(psk))
		}
	}
	return strings.Join(out, "\n"), nil
}
