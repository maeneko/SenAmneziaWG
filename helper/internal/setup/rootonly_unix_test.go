//go:build linux || darwin

package setup

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRootOnlyAcceptsSystemDirs(t *testing.T) {
	// Not created by the test: /usr and / are root's on both systems the tests run on.
	if err := RootOnly("/usr/senawg-test-missing/SenAWG"); err != nil {
		t.Fatalf("a missing folder under /usr: %v", err)
	}
}

func TestRootOnlyRefusesUserDirs(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("as root, the temp folder is root's")
	}
	home := t.TempDir()
	for _, dir := range []string{home, filepath.Join(home, "SenAWG"), filepath.Join(home, "a", "b", "SenAWG")} {
		if err := RootOnly(dir); err == nil {
			t.Errorf("%s: accepted a folder the user owns", dir)
		}
	}
}

func TestRootOnlyRefusesWorldWritable(t *testing.T) {
	// /tmp is root's but anyone may write there (on macOS it is a link to /private/tmp).
	if err := RootOnly("/tmp/senawg-test-missing/SenAWG"); err == nil {
		t.Error("accepted a folder under /tmp")
	}
}

func TestRootOnlyRefusesLinkIntoUserDir(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("as root, the temp folder is root's")
	}
	home := t.TempDir()
	link := filepath.Join(home, "link")
	if err := os.Symlink("/usr", link); err != nil {
		t.Fatal(err)
	}
	if err := RootOnly(filepath.Join(link, "SenAWG")); err == nil {
		t.Error("accepted a path through a link the user owns")
	}
}

func TestRootOnlyRefusesRelative(t *testing.T) {
	if err := RootOnly("opt/SenAWG"); err == nil {
		t.Error("accepted a relative path")
	}
}
