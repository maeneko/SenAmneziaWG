package setup

import (
	"bufio"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestParseArgs(t *testing.T) {
	got, err := ParseArgs([]string{"--app-from", `C:\Temp\x`, "--app-to", `D:\SenAWG`, "--progress", `C:\Temp\p.jsonl`})
	if err != nil {
		t.Fatal(err)
	}
	want := Args{From: `C:\Temp\x`, To: `D:\SenAWG`, Progress: `C:\Temp\p.jsonl`}
	if got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
	upd, err := ParseArgs([]string{"--app-from", "a", "--app-to", "b", "--update-wait-pid", "4242"})
	if err != nil || upd.UpdateWaitPID != 4242 {
		t.Fatalf("update flag: %+v, %v", upd, err)
	}
	for name, args := range map[string][]string{
		"pid is not a number": {"--app-from", "a", "--app-to", "b", "--update-wait-pid", "x"},
		"pid zero":            {"--app-from", "a", "--app-to", "b", "--update-wait-pid", "0"},
		"no target":           {"--app-from", "a"},
		"no value":            {"--app-from", "a", "--app-to"},
		"unknown key":         {"--app-from", "a", "--app-to", "b", "--force", "1"},
		"empty":               {},
	} {
		if _, err := ParseArgs(args); err == nil {
			t.Errorf("%s: want an error", name)
		}
	}
}

func TestReporterWritesOneJSONObjectPerLine(t *testing.T) {
	path := filepath.Join(t.TempDir(), "p.jsonl")
	r, err := NewReporter(path)
	if err != nil {
		t.Fatal(err)
	}
	r.Active(StepFiles)
	r.Done(StepFiles)
	r.Fail(StepService, `не удалось "установить"`)
	r.Close()

	f, _ := os.Open(path)
	defer f.Close()
	var lines []string
	for s := bufio.NewScanner(f); s.Scan(); {
		lines = append(lines, s.Text())
	}
	want := []string{
		`{"step":0,"state":"active"}`,
		`{"step":0,"state":"done"}`,
		`{"failed":{"step":1,"message":"не удалось \"установить\""}}`,
	}
	if !reflect.DeepEqual(lines, want) {
		t.Fatalf("got\n%s\nwant\n%s", strings.Join(lines, "\n"), strings.Join(want, "\n"))
	}
}

func TestReporterStaged(t *testing.T) {
	path := filepath.Join(t.TempDir(), "p.jsonl")
	r, _ := NewReporter(path)
	r.Staged()
	r.Close()
	b, _ := os.ReadFile(path)
	if string(b) != "{\"staged\":true}\n" {
		t.Fatalf("got %q", b)
	}
}

func TestReporterWithoutFileDiscards(t *testing.T) {
	r, err := NewReporter("")
	if err != nil {
		t.Fatal(err)
	}
	r.Active(0) // must not panic
	r.Close()
}

func TestCopyTreeReportsOnlyWhatItCreatedAndUndoTakesItBack(t *testing.T) {
	src := t.TempDir()
	write := func(root, rel, body string) {
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(src, "SenAWG.exe", "app")
	write(src, "resources/app.asar", "asar")

	// The user picked a folder that already has something of theirs in it.
	dst := filepath.Join(t.TempDir(), "SenAWG")
	write(dst, "notes.txt", "mine")
	write(dst, "SenAWG.exe", "old")

	created, err := CopyTree(src, dst)
	if err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(dst, "SenAWG.exe")); string(b) != "app" {
		t.Fatalf("existing file was not overwritten: %q", b)
	}
	for _, p := range created {
		if filepath.Base(p) == "SenAWG.exe" || filepath.Base(p) == "notes.txt" {
			t.Errorf("%s existed before, must not be listed", p)
		}
	}

	Undo(created)
	if _, err := os.Stat(filepath.Join(dst, "resources")); !os.IsNotExist(err) {
		t.Errorf("resources should be gone after Undo")
	}
	if b, _ := os.ReadFile(filepath.Join(dst, "notes.txt")); string(b) != "mine" {
		t.Errorf("the user's own file was touched: %q", b)
	}
}

func TestCopyTreeRefusesLinks(t *testing.T) {
	src := t.TempDir()
	if err := os.Symlink(src, filepath.Join(src, "loop")); err != nil {
		t.Skip("no symlinks here")
	}
	if _, err := CopyTree(src, t.TempDir()); err == nil {
		t.Fatal("want an error for a link in the payload")
	}
}

func TestAppDir(t *testing.T) {
	for in, want := range map[string]string{
		`C:\Program Files\SenAWG`:  `C:\Program Files\SenAWG`,
		`C:\Program Files\SenAWG\`: `C:\Program Files\SenAWG`,
		`D:\Programs`:              `D:\Programs\SenAWG`,
		`D:\Programs\senawg`:       `D:\Programs\senawg`,
		`D:\`:                      `D:\SenAWG`,
		`  D:\Programs\Other  `:    `D:\Programs\Other\SenAWG`,
		``:                         ``,
		`D:\Programs\SenAWG-old`:   `D:\Programs\SenAWG-old\SenAWG`,
	} {
		if got := AppDir(in); got != want {
			t.Errorf("AppDir(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestMkdirAllTrackedListsOnlyNewDirectories(t *testing.T) {
	base := t.TempDir()
	dir := filepath.Join(base, "a", "b", "c")
	created, err := MkdirAllTracked(dir)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{filepath.Join(base, "a"), filepath.Join(base, "a", "b"), dir}
	if !reflect.DeepEqual(created, want) {
		t.Fatalf("got %v, want %v", created, want)
	}
	again, _ := MkdirAllTracked(dir)
	if len(again) != 0 {
		t.Fatalf("second call created %v", again)
	}
	Undo(created)
	if _, err := os.Stat(filepath.Join(base, "a")); !os.IsNotExist(err) {
		t.Fatal("a should be gone")
	}
}

func TestParseRemoveArgs(t *testing.T) {
	for name, tc := range map[string]struct {
		args []string
		want RemoveArgs
	}{
		"from Programs and Features": {nil, RemoveArgs{}},
		"from the app":               {[]string{"--progress", `C:\Temp\r.jsonl`}, RemoveArgs{Progress: `C:\Temp\r.jsonl`}},
		"the copy in TEMP":           {[]string{"--finish", "--progress", `C:\p`}, RemoveArgs{Finish: true, Progress: `C:\p`}},
		"old hand-over":              {[]string{"--finish"}, RemoveArgs{Finish: true}},
		"keeping the keys (Linux)":   {[]string{"--progress", "/tmp/r", "--keep-secrets"}, RemoveArgs{Progress: "/tmp/r", KeepSecrets: true}},
	} {
		got, err := ParseRemoveArgs(tc.args)
		if err != nil || got != tc.want {
			t.Errorf("%s: got %+v, %v", name, got, err)
		}
		// What is handed over to the copy in %TEMP% must read back the same.
		again, err := ParseRemoveArgs(append([]string{"--finish"}, got.Args()...))
		if err != nil || again.Progress != got.Progress || !again.Finish {
			t.Errorf("%s: hand-over lost something: %+v, %v", name, again, err)
		}
	}
	for name, args := range map[string][]string{
		"no value":    {"--progress"},
		"empty value": {"--progress", ""},
		"unknown":     {"--wipe", `C:\`},
	} {
		if _, err := ParseRemoveArgs(args); err == nil {
			t.Errorf("%s: want an error", name)
		}
	}
}
