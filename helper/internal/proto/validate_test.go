package proto

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var key = base64.StdEncoding.EncodeToString(make([]byte, 32))

// conf builds a config from extra lines appended to a minimal valid base.
func conf(interfaceExtra, peerExtra string) string {
	return "[Interface]\nPrivateKey = " + key + "\nAddress = 10.8.1.2/32\n" + interfaceExtra +
		"\n[Peer]\nPublicKey = " + key + "\nAllowedIPs = 0.0.0.0/0, ::/0\nEndpoint = vpn.example.org:51820\n" + peerExtra
}

func TestValidateConfAccepts(t *testing.T) {
	cases := map[string]string{
		"minimal":              conf("", ""),
		"all obfuscation":      conf("Jc = 4\nJmin = 10\nJmax = 50\nS1 = 60\nS2 = 100\nS3 = 20\nS4 = 30\nH1 = 100-200\nH2 = 3\nH3 = 4\nH4 = 5\nI1 = <b 0xf6ab><c><t><r 10>\nHeaderProtectionKey = "+key+"\nContentPaddingAddition = 16\nRandomTrailers = on\nDisableCookies = off\nMTU = 1280\nDNS = 1.1.1.1, 2606:4700:4700::1111\n", "PresharedKey = "+key+"\nPersistentKeepalive = 25\n"),
		"3.x values as ranges": conf("HeaderProtectionKey = "+key+"\nContentPaddingAddition = 0-64\nRekeyAfterTime = 110-130\nRekeyTimeout = 5-8\nRejectAfterTime = 170-190\nKeepaliveTimeout = 8-12\nMaxHandshakeAttempts = 5\n", ""),
		"ipv4 endpoint":        strings.Replace(conf("", ""), "vpn.example.org:51820", "203.0.113.7:51820", 1),
		"ipv6 endpoint":        strings.Replace(conf("", ""), "vpn.example.org:51820", "[2001:db8::1]:51820", 1),
		"windows newline":      strings.ReplaceAll(conf("", ""), "\n", "\r\n"),
		"bare addresses":       strings.Replace(conf("", ""), "10.8.1.2/32", "10.8.1.2, fd00::2", 1),
		"mixed case keys":      strings.Replace(conf("", ""), "PrivateKey", "privatekey", 1),
	}
	for name, text := range cases {
		if err := ValidateConf(text); err != nil {
			t.Errorf("%s: rejected: %v", name, err)
		}
	}
}

func TestValidateConfRejects(t *testing.T) {
	cases := map[string]string{
		"PostUp runs a command":      conf("PostUp = calc.exe\n", ""),
		"PreUp":                      conf("PreUp = calc.exe\n", ""),
		"Table":                      conf("Table = off\n", ""),
		"ListenPort":                 conf("ListenPort = 51820\n", ""),
		"unknown future key":         conf("FutureKey = 1\n", ""),
		"key smuggled in a value":    conf("DNS = 1.1.1.1\nPostUp = calc.exe\n", ""),
		"comment":                    conf("# hello\n", ""),
		"inline comment":             conf("MTU = 1280 # x\n", ""),
		"second interface":           conf("", "") + "\n[Interface]\nPrivateKey = " + key + "\nAddress = 10.0.0.1/32\n",
		"second peer":                conf("", "") + "\n[Peer]\nPublicKey = " + key + "\nAllowedIPs = 0.0.0.0/0\nEndpoint = a.b:1\n",
		"unknown section":            conf("", "") + "\n[Script]\nx = y\n",
		"line outside a section":     "PrivateKey = " + key + "\n" + conf("", ""),
		"duplicate key":              conf("MTU = 1280\nMTU = 1300\n", ""),
		"no private key":             strings.Replace(conf("", ""), "PrivateKey = "+key+"\n", "", 1),
		"no endpoint":                strings.Replace(conf("", ""), "Endpoint = vpn.example.org:51820\n", "", 1),
		"short key":                  strings.Replace(conf("", ""), key, "AAAA", 1),
		"endpoint with command":      strings.Replace(conf("", ""), "vpn.example.org:51820", "a.b:1;calc", 1),
		"endpoint without port":      strings.Replace(conf("", ""), "vpn.example.org:51820", "vpn.example.org", 1),
		"endpoint port zero":         strings.Replace(conf("", ""), "vpn.example.org:51820", "vpn.example.org:0", 1),
		"bare ipv6 endpoint":         strings.Replace(conf("", ""), "vpn.example.org:51820", "2001:db8::1:51820", 1),
		"endpoint with a path":       strings.Replace(conf("", ""), "vpn.example.org:51820", "..\\evil:1", 1),
		"mtu too small":              conf("MTU = 100\n", ""),
		"mtu not a number":           conf("MTU = big\n", ""),
		"dns domain, not an ip":      conf("DNS = example.com\n", ""),
		"header not a number":        conf("H1 = abc\n", ""),
		"range with a word":          conf("RekeyAfterTime = 110-abc\n", ""),
		"open ended range":           conf("ContentPaddingAddition = 64-\n", ""),
		"range where a count is due": conf("MaxHandshakeAttempts = 3-5\n", ""),
		"toggle with a word":         conf("RandomTrailers = maybe\n", ""),
		"non-ascii in a packet":      conf("I1 = <b 0x00>é\n", ""),
		"address not a cidr":         strings.Replace(conf("", ""), "10.8.1.2/32", "10.8.1.2/99", 1),
		"allowed ips with a word":    strings.Replace(conf("", ""), "0.0.0.0/0, ::/0", "everything", 1),
		"too many list items":        strings.Replace(conf("", ""), "10.8.1.2/32", strings.Repeat("10.0.0.1, ", 40)+"10.0.0.2", 1),
		"no key value separator":     conf("Jc 4\n", ""),
		"nothing":                    "",
		"only an interface section":  "[Interface]\nPrivateKey = " + key + "\nAddress = 10.0.0.1/32\n",
	}
	for name, text := range cases {
		if err := ValidateConf(text); err == nil {
			t.Errorf("%s: was accepted", name)
		}
	}
}

func TestValidateUp(t *testing.T) {
	ok := &Request{ID: "3f9a1c2b-0d4e", Name: "Германия", Conf: conf("", "")}
	if err := ValidateUp(ok); err != nil {
		t.Fatalf("valid request rejected: %v", err)
	}
	bad := map[string]*Request{
		"id with a path separator": {ID: `..\..\x`, Conf: ok.Conf},
		"empty id":                 {ID: "", Conf: ok.Conf},
		"huge name":                {ID: "a", Name: strings.Repeat("x", 257), Conf: ok.Conf},
		"empty conf":               {ID: "a", Conf: ""},
		"huge conf":                {ID: "a", Conf: strings.Repeat("A", MaxConf+1)},
		"bad conf":                 {ID: "a", Conf: conf("PostUp = x\n", "")},
	}
	for name, r := range bad {
		if err := ValidateUp(r); err == nil {
			t.Errorf("%s: was accepted", name)
		} else if err.Code != CodeBadRequest && err.Code != CodeConfInvalid {
			t.Errorf("%s: unexpected code %s", name, err.Code)
		}
	}
}

func TestSafeName(t *testing.T) {
	if got := SafeName("Дом\r\n\x00[INFO] fake"); got != "Дом[INFO] fake" {
		t.Fatalf("got %q", got)
	}
}

// The app's own generator (tests/wgConf.test.ts writes these files) must always pass its own validator.
func TestValidateConfAcceptsWhatTheAppGenerates(t *testing.T) {
	files, _ := filepath.Glob("testdata/*.conf")
	if len(files) == 0 {
		t.Skip("no generated fixtures yet")
	}
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		if err := ValidateConf(string(b)); err != nil {
			t.Errorf("%s: %v", filepath.Base(f), err)
		}
	}
}
