package proto

import (
	"encoding/base64"
	"encoding/hex"
	"errors"
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
