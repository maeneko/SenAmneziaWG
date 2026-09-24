package proto

import (
	"os"
	"path/filepath"
	"testing"
)

// Every generation's fixture is what src/main/tunnel/uapiConfig.ts (buildUapiSet) produces for a real
// config; the Linux and macOS backends send exactly this. ValidateUAPI must accept every one of them,
// the same way ValidateConf accepts every testdata/*.conf (helper's forkparse test checks the two agree).
func TestValidateUAPIAcceptsEveryFixture(t *testing.T) {
	for _, g := range []string{"wireguard", "legacy", "2.0", "3.0", "3.1"} {
		g := g
		t.Run(g, func(t *testing.T) {
			b, err := os.ReadFile(filepath.Join("testdata", g+".uapi"))
			if err != nil {
				t.Fatal(err)
			}
			if err := ValidateUAPI(string(b)); err != nil {
				t.Fatalf("rejected a config buildUapiSet actually produces: %v", err)
			}
		})
	}
}

func TestValidateUAPIRejectsUnknownKey(t *testing.T) {
	body := "set=1\nprivate_key=" + hex64('1') + "\nreplace_peers=true\nlisten_port=51820\n" +
		"public_key=" + hex64('2') + "\nendpoint=203.0.113.7:51820\nreplace_allowed_ips=true\nallowed_ip=0.0.0.0/0\n"
	if err := ValidateUAPI(body); err == nil {
		t.Fatal("listen_port must not be accepted: nothing lets the app choose the daemon's listen port")
	}
}

func TestValidateUAPIRejectsMissingEndpoint(t *testing.T) {
	body := "set=1\nprivate_key=" + hex64('1') + "\nreplace_peers=true\n" +
		"public_key=" + hex64('2') + "\nreplace_allowed_ips=true\nallowed_ip=0.0.0.0/0\n"
	if err := ValidateUAPI(body); err == nil {
		t.Fatal("endpoint is required")
	}
}

func TestValidateUAPIRejectsSecondPeer(t *testing.T) {
	body := "set=1\nprivate_key=" + hex64('1') + "\nreplace_peers=true\n" +
		"public_key=" + hex64('2') + "\nendpoint=203.0.113.7:51820\nreplace_allowed_ips=true\nallowed_ip=0.0.0.0/0\n" +
		"public_key=" + hex64('3') + "\nendpoint=203.0.113.8:51820\n"
	if err := ValidateUAPI(body); err == nil {
		t.Fatal("a second public_key must not be accepted: it would program a second peer")
	}
}

func hex64(c byte) string {
	b := make([]byte, 64)
	for i := range b {
		b[i] = c
	}
	return string(b)
}
