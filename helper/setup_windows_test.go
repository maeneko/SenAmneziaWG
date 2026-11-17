package main

import (
	"os"
	"path/filepath"
	"testing"

	"senawg-helper/internal/setup"
)

// The regression behind «The process cannot access the file because it is being used by another
// process»: Windows will not rename a folder that is the working directory of a live process, and the
// setup helper inherited the installed folder from the app.
func TestLeaveInstallDirFreesTheFolderForSwap(t *testing.T) {
	here, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(here) })

	root := t.TempDir()
	from := filepath.Join(root, "from")
	appDir := filepath.Join(root, "SenAWG")
	for _, f := range []struct{ path, text string }{
		{filepath.Join(from, "app.exe"), "new"},
		{filepath.Join(appDir, "app.exe"), "old"},
	} {
		if err := os.MkdirAll(filepath.Dir(f.path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(f.path, []byte(f.text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := setup.Stage(from, appDir); err != nil {
		t.Fatal(err)
	}

	if err := os.Chdir(appDir); err != nil {
		t.Fatal(err)
	}
	if _, err := setup.Swap(appDir); err == nil {
		t.Fatal("Windows renamed the folder that is this process's working directory")
	}
	if err := leaveInstallDir(); err != nil {
		t.Fatal(err)
	}
	if _, err := setup.Swap(appDir); err != nil {
		t.Fatalf("swap after leaving the folder: %v", err)
	}
}
