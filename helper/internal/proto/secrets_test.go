package proto

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var (
	testPriv = base64.StdEncoding.EncodeToString(make([]byte, 32))
	testPSK  = base64.StdEncoding.EncodeToString([]byte(strings.Repeat("\x01", 32)))
)

// stripKeys turns a fixture into what the app sends when the service holds the keys.
func stripKeys(conf string) string {
	var out []string
	for _, line := range strings.Split(conf, "\n") {
		if !strings.HasPrefix(line, "private_key=") && !strings.HasPrefix(line, "preshared_key=") {
			out = append(out, line)
		}
	}
	return strings.Join(out, "\n")
}

func TestInjectSecretsFixtures(t *testing.T) {
	files, _ := filepath.Glob("testdata/*.uapi")
	if len(files) == 0 {
		t.Fatal("no fixtures")
	}
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		conf, err := InjectSecrets(stripKeys(strings.ReplaceAll(string(b), "\r\n", "\n")), testPriv, testPSK)
		if err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		if err := ValidateUAPI(conf); err != nil {
			t.Errorf("%s: injected body rejected: %v", f, err)
		}
		if !strings.Contains(conf, "\nprivate_key="+strings.Repeat("0", 64)+"\n") {
			t.Errorf("%s: private key missing", f)
		}
		if !strings.Contains(conf, "\npreshared_key="+strings.Repeat("01", 32)) {
			t.Errorf("%s: preshared key missing", f)
		}
	}
}

func TestInjectSecretsRejects(t *testing.T) {
	if _, err := InjectSecrets("set=1\nprivate_key="+strings.Repeat("0", 64)+"\n", testPriv, ""); err == nil {
		t.Error("a body that already has a key must be rejected")
	}
	if _, err := InjectSecrets("set=1\n", "bm90IGEga2V5", ""); err == nil {
		t.Error("a corrupt stored key must be rejected")
	}
}

func TestValidateSecretPut(t *testing.T) {
	ok := &Request{ID: "0b1c-22", PrivateKey: testPriv, PresharedKey: testPSK}
	if err := ValidateSecretPut(ok); err != nil {
		t.Fatalf("valid request rejected: %v", err)
	}
	for name, req := range map[string]*Request{
		"path in id":  {ID: "../x", PrivateKey: testPriv},
		"empty id":    {PrivateKey: testPriv},
		"short key":   {ID: "a", PrivateKey: "AAAA"},
		"bad psk":     {ID: "a", PrivateKey: testPriv, PresharedKey: "!!"},
		"missing key": {ID: "a"},
	} {
		if ValidateSecretPut(req) == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestValidateSenSign(t *testing.T) {
	const hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	good := "GET\n/sub/v1/config\n1700000000\n" + hash
	ok := func(id, msg string) bool {
		return ValidateSenSign(&Request{ID: id, Message: msg}) == nil
	}
	if !ok("sen-0b1c2d3e-aaaa-bbbb-cccc-1234567890ab", good) {
		t.Fatal("a real request string was refused")
	}
	if !ok("sen-x", "POST\n/sub/v1/rekey\n1\n"+hash) {
		t.Fatal("rekey was refused")
	}
	for name, c := range map[string]struct{ id, msg string }{
		"a tunnel id, not an auth key": {"0b1c2d3e-aaaa-bbbb-cccc-1234567890ab", good},
		"traversal in the id":          {"sen-../x", good},
		"empty id":                     {"", good},
		"not under /sub/v1":            {"sen-x", "GET\n/api/peers\n1\n" + hash},
		"bad method":                   {"sen-x", "PATCH\n/sub/v1/config\n1\n" + hash},
		"arbitrary text":               {"sen-x", "hello"},
		"upper-case hash":              {"sen-x", "GET\n/sub/v1/config\n1\n" + "E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855"},
		"trailing data":                {"sen-x", good + "\nextra"},
	} {
		if ok(c.id, c.msg) {
			t.Errorf("%s: accepted", name)
		}
	}
}
