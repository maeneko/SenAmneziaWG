//go:build linux

package main

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

// What pkexec's text agent needs: /dev/tty opens, and what is typed into the relay comes back on it.
func TestPtyIsTheControllingTerminal(t *testing.T) {
	var out bytes.Buffer
	code, err := ptyRun([]string{"sh", "-c", `exec 3<>/dev/tty; printf 'Password: ' >&3; read -r p <&3; echo "got $p"; exit 3`},
		strings.NewReader("s3cret\n"), &out)
	if err != nil {
		t.Fatal(err)
	}
	if code != 3 {
		t.Errorf("exit code %d, want the command's 3; output %q", code, out.String())
	}
	if !strings.Contains(out.String(), "Password: ") || !strings.Contains(out.String(), "got s3cret") {
		t.Errorf("output %q", out.String())
	}
}

// `awg-helper setup` starts the service detached, and it may keep the terminal: that must not hold the relay.
func TestPtyReturnsWhenTheCommandDoesNotItsChildren(t *testing.T) {
	var out bytes.Buffer
	start := time.Now()
	code, err := ptyRun([]string{"sh", "-c", "sleep 5 & echo done"}, strings.NewReader(""), &out)
	if err != nil {
		t.Fatal(err)
	}
	if code != 0 || !strings.Contains(out.String(), "done") {
		t.Errorf("code %d, output %q", code, out.String())
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Errorf("took %v: waited for the child's child", d)
	}
}

func TestPtyCommandNotFound(t *testing.T) {
	if _, err := ptyRun([]string{"/nonexistent/pkexec"}, strings.NewReader(""), &bytes.Buffer{}); err == nil {
		t.Fatal("want an error")
	}
}
