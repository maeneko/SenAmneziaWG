package main

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/amnezia-vpn/amneziawg-windows/v3/conf"
)

var generations = []string{"wireguard", "legacy", "2.0", "3.0", "3.1"}

func fixture(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("internal", "proto", "testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// lines is a UAPI body as a sorted set of lines: order is irrelevant to the daemon, and `set=1` is only
// the framing of the socket protocol that the macOS path uses (the tunnel service calls IpcSet directly).
func lines(body string) []string {
	var out []string
	for _, l := range strings.Split(body, "\n") {
		if l = strings.TrimSpace(l); l != "" && l != "set=1" {
			out = append(out, l)
		}
	}
	sort.Strings(out)
	return out
}

// The tunnel service reads the file with the fork's own parser. A config our validator accepts but this
// reader rejects would only fail at connect time, on the user's machine.
func TestForkParserAcceptsGeneratedConfigs(t *testing.T) {
	for _, g := range generations {
		if _, err := conf.FromWgQuick(fixture(t, g+".conf"), "AmnesiaWG"); err != nil {
			t.Errorf("%s: %v", g, err)
		}
	}
}

// macOS configures the daemon from buildUapiSet; Windows from the fork's ToUAPI over the same .conf.
// Both must set the same obfuscation parameters, keys and peer, or the two apps would speak differently
// to the same server.
func TestBothPlatformsConfigureTheDaemonIdentically(t *testing.T) {
	for _, g := range generations {
		cfg, err := conf.FromWgQuick(fixture(t, g+".conf"), "AmnesiaWG")
		if err != nil {
			t.Fatalf("%s: %v", g, err)
		}
		got, err := cfg.ToUAPI()
		if err != nil {
			t.Fatalf("%s: ToUAPI: %v", g, err)
		}
		want, have := lines(fixture(t, g+".uapi")), lines(got)
		if strings.Join(want, "\n") != strings.Join(have, "\n") {
			t.Errorf("%s differs\n macOS path:\n  %s\n Windows path:\n  %s", g, strings.Join(want, "\n  "), strings.Join(have, "\n  "))
		}
	}
}
