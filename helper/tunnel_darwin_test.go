//go:build darwin

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCheckRootOnly(t *testing.T) {
	if err := checkRootOnly("/usr/bin/true"); err != nil {
		t.Fatalf("a system binary is root-only: %v", err)
	}
	if os.Getuid() == 0 {
		t.Skip("running as root: every file created here is root's")
	}
	mine := filepath.Join(t.TempDir(), "awg.sh")
	if err := os.WriteFile(mine, []byte("#!/bin/bash\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := checkRootOnly(mine); err == nil {
		t.Fatal("a file the user owns must be refused")
	}
	link := filepath.Join(t.TempDir(), "amneziawg-go")
	if err := os.Symlink("/usr/bin/true", link); err != nil {
		t.Fatal(err)
	}
	if err := checkRootOnly(link); err == nil {
		t.Fatal("a symlink must be refused: whoever owns its directory can repoint it")
	}
}

// Root-owned files are not enough when a directory above them is the user's: a rename swaps them.
func TestCheckInstallRefusesUserDirectory(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("running as root")
	}
	dir := t.TempDir()
	err := checkInstall(dir)
	if err == nil || !strings.Contains(err.Error(), dir) {
		t.Fatalf("an install in a directory the user owns must be refused for that directory, got %v", err)
	}
}

func TestAwaitExitAndProcessName(t *testing.T) {
	cmd := exec.Command("/bin/sleep", "0.3")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	pid := uint32(cmd.Process.Pid)
	if name := processName(pid); name != "sleep" {
		t.Fatalf("processName = %q", name)
	}
	go func() { _ = cmd.Wait() }()
	done := make(chan error, 1)
	go func() { done <- awaitExit(pid) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("awaitExit did not return after the process exited")
	}
	if err := awaitExit(pid); err != nil {
		t.Fatalf("a pid already gone: %v", err)
	}
}

// launchd reads the plist with the same parser plutil uses; a malformed one is simply not loaded.
func TestServicePlistIsValid(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ru.senawg.helper.plist")
	if err := os.WriteFile(path, []byte(servicePlist(filepath.Join(installTarget, "awg-helper"), socketPath, serviceStderrLog)), 0o644); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("/usr/bin/plutil", "-lint", path).CombinedOutput(); err != nil {
		t.Fatalf("plutil: %s", out)
	}
	out, err := exec.Command("/usr/bin/plutil", "-extract", "Sockets.Listener.SockPathMode", "raw", "-o", "-", path).Output()
	if err != nil || strings.TrimSpace(string(out)) != "438" {
		t.Fatalf("SockPathMode = %q (%v), want 438 (0666)", out, err)
	}
}
