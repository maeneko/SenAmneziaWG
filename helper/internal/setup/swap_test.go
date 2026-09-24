package setup

import (
	"os"
	"path/filepath"
	"testing"
)

func write(t *testing.T, path, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

func read(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// layout: <root>/from (the new version), <root>/SenAWG (the installed one).
func fixture(t *testing.T) (from, appDir string) {
	root := t.TempDir()
	from, appDir = filepath.Join(root, "from"), filepath.Join(root, "SenAWG")
	write(t, filepath.Join(from, "app.exe"), "new")
	write(t, filepath.Join(from, "res", "a.txt"), "new-a")
	write(t, filepath.Join(appDir, "app.exe"), "old")
	write(t, filepath.Join(appDir, "old-only.txt"), "x")
	return
}

func TestStageLeavesTheInstalledVersionAlone(t *testing.T) {
	from, appDir := fixture(t)
	if err := Stage(from, appDir); err != nil {
		t.Fatal(err)
	}
	if got := read(t, filepath.Join(appDir, "app.exe")); got != "old" {
		t.Fatalf("installed app touched: %q", got)
	}
	if got := read(t, filepath.Join(NextDir(appDir), "res", "a.txt")); got != "new-a" {
		t.Fatalf("staged copy: %q", got)
	}
}

func TestStageReplacesAnAbandonedAttempt(t *testing.T) {
	from, appDir := fixture(t)
	write(t, filepath.Join(NextDir(appDir), "stale.txt"), "stale")
	if err := Stage(from, appDir); err != nil {
		t.Fatal(err)
	}
	if exists(filepath.Join(NextDir(appDir), "stale.txt")) {
		t.Fatal("a file of the abandoned attempt survived")
	}
}

func TestSwapAndRollback(t *testing.T) {
	from, appDir := fixture(t)
	if err := Stage(from, appDir); err != nil {
		t.Fatal(err)
	}
	rollback, err := Swap(appDir)
	if err != nil {
		t.Fatal(err)
	}
	if got := read(t, filepath.Join(appDir, "app.exe")); got != "new" {
		t.Fatalf("after swap: %q", got)
	}
	if got := read(t, filepath.Join(OldDir(appDir), "old-only.txt")); got != "x" {
		t.Fatal("the previous version was not kept for a rollback")
	}
	if exists(NextDir(appDir)) {
		t.Fatal("the staged folder is still there")
	}

	rollback()
	if got := read(t, filepath.Join(appDir, "app.exe")); got != "old" {
		t.Fatalf("after rollback: %q", got)
	}
	if exists(filepath.Join(appDir, "res")) || exists(OldDir(appDir)) {
		t.Fatal("rollback left the new version or the .old folder")
	}
}

func TestSwapThenDiscardOld(t *testing.T) {
	from, appDir := fixture(t)
	if err := Stage(from, appDir); err != nil {
		t.Fatal(err)
	}
	if _, err := Swap(appDir); err != nil {
		t.Fatal(err)
	}
	DiscardOld(appDir)
	if exists(OldDir(appDir)) {
		t.Fatal(".old was not removed")
	}
	if got := read(t, filepath.Join(appDir, "app.exe")); got != "new" {
		t.Fatalf("installed: %q", got)
	}
}

func TestSwapWithoutStageIsAnErrorAndTouchesNothing(t *testing.T) {
	_, appDir := fixture(t)
	if _, err := Swap(appDir); err == nil {
		t.Fatal("want an error")
	}
	if got := read(t, filepath.Join(appDir, "app.exe")); got != "old" {
		t.Fatalf("installed app changed: %q", got)
	}
}

func TestDiscardStage(t *testing.T) {
	from, appDir := fixture(t)
	if err := Stage(from, appDir); err != nil {
		t.Fatal(err)
	}
	DiscardStage(appDir)
	if exists(NextDir(appDir)) {
		t.Fatal("still staged")
	}
}
