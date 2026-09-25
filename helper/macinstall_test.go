package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"senawg-helper/internal/setup"
)

// resourcesFixture lays out the three service files as the app bundle's Contents/Resources has them.
func resourcesFixture(t *testing.T) string {
	t.Helper()
	res := t.TempDir()
	for _, f := range serviceFiles {
		path := filepath.Join(res, f.source)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("content of "+f.name+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return res
}

func TestStageServiceCopiesUnderInstalledNames(t *testing.T) {
	res := resourcesFixture(t)
	target := filepath.Join(t.TempDir(), "ru.senawg.helper")
	next := setup.NextDir(target)
	// Left by an abandoned attempt: must not survive into the new copy.
	if err := os.MkdirAll(next, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(next, "stale"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := stageService(res, target); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(next)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	if strings.Join(names, ",") != "amneziawg-go,awg-helper,awg.sh" {
		t.Fatalf("staged %v", names)
	}
	for _, f := range serviceFiles {
		fi, err := os.Stat(filepath.Join(next, f.name))
		if err != nil {
			t.Fatal(err)
		}
		if fi.Mode().Perm() != 0o755 {
			t.Errorf("%s: mode %v, want 0755 (whatever the source had)", f.name, fi.Mode().Perm())
		}
	}
	a, _ := buildID(res, true)
	b, _ := buildID(next, false)
	if a == "" || a != b {
		t.Fatalf("the app's Resources and the staged copy must hash the same: %q vs %q", a, b)
	}
}

func TestStageServiceMissingFileLeavesNothing(t *testing.T) {
	res := resourcesFixture(t)
	if err := os.Remove(filepath.Join(res, "scripts", "awg.sh")); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "ru.senawg.helper")
	if err := stageService(res, target); err == nil {
		t.Fatal("a missing file must fail the stage")
	}
	if _, err := os.Stat(setup.NextDir(target)); !os.IsNotExist(err) {
		t.Fatalf("a failed stage must leave nothing behind: %v", err)
	}
}

func TestStageServiceRefusesDirectoryInPlaceOfFile(t *testing.T) {
	res := resourcesFixture(t)
	path := filepath.Join(res, "bin", "amneziawg-go")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := stageService(res, filepath.Join(t.TempDir(), "x")); err == nil {
		t.Fatal("a directory is not a service file")
	}
}

// Pinned: src/main (stage 3) computes the same id over the app's Resources and must agree byte for byte.
func TestBuildIDVector(t *testing.T) {
	res := resourcesFixture(t)
	id, err := buildID(res, true)
	if err != nil {
		t.Fatal(err)
	}
	const want = "a6180229431be0f16ec837ea976c1bee67a7f53cb261c7d92cf255c70d3b396f"
	if id != want {
		t.Fatalf("buildID = %s", id)
	}
	if err := os.WriteFile(filepath.Join(res, "scripts", "awg.sh"), []byte("changed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if changed, _ := buildID(res, true); changed == id {
		t.Fatal("a changed awg.sh must change the build id")
	}
}

func TestServicePlist(t *testing.T) {
	p := servicePlist("/Library/PrivilegedHelperTools/ru.senawg.helper/awg-helper", "/var/run/ru.senawg.helper.sock", "/var/log/x.log")
	for _, part := range []string{
		"<string>ru.senawg.helper</string>",
		"<string>/Library/PrivilegedHelperTools/ru.senawg.helper/awg-helper</string>\n\t\t<string>service</string>",
		"<key>Listener</key>",
		"<string>/var/run/ru.senawg.helper.sock</string>",
		"<integer>438</integer>",
		"<key>AbandonProcessGroup</key>\n\t<true/>",
	} {
		if !strings.Contains(p, part) {
			t.Errorf("plist lacks %q", part)
		}
	}
	for _, absent := range []string{"RunAtLoad", "KeepAlive"} {
		if strings.Contains(p, absent) {
			t.Errorf("the service starts on demand only: %s must not be set", absent)
		}
	}
	if strings.Contains(servicePlist("/a<b&c", "/s", "/l"), "<b&c") {
		t.Fatal("paths must be XML-escaped")
	}
}
