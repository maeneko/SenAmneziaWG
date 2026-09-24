// awg-helper is the Linux side of SenAWG. One executable, four jobs:
//
//	awg-helper service            what pkexec runs: starts the real service detached and returns once
//	                               its socket answers (sc.exe's own "start returns once running" shape)
//	awg-helper service --daemon   the detached process itself; never invoked by hand
//	awg-helper setup --app-from D --app-to D  installs SenAWG under D (elevated, via pkexec)
//	awg-helper remove    the reverse of setup (elevated, via pkexec, or run by hand as root)
//	awg-helper version
package main

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"senawg-helper/internal/lifetime"
)

const usage = "usage: awg-helper service | setup --app-from <dir> --app-to <dir> [--progress <file>] | remove [--progress <file>] | version"

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	}
	switch os.Args[1] {
	case "service":
		if len(os.Args) > 2 && os.Args[2] == "--daemon" {
			os.Exit(runServiceDaemon())
		}
		os.Exit(runServiceLauncher())
	case "setup":
		os.Exit(runSetup(os.Args[2:]))
	case "remove":
		os.Exit(runRemove(os.Args[2:]))
	case "version":
		fmt.Printf("awg-helper %s (amneziawg-go %s)\n", version, awgGoVersion())
	default:
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	}
}

const (
	idleTimeout    = 60 * time.Second
	launchDeadline = 5 * time.Second
)

func servicePIDPath() string { return layout().run + "/service.pid" }

func readServicePID() (int, bool) {
	b, err := os.ReadFile(servicePIDPath())
	if err != nil {
		return 0, false
	}
	pid, err := strconv.Atoi(string(b))
	return pid, err == nil && pid > 0
}

func socketAnswers() bool {
	conn, err := net.DialTimeout("unix", socketPath, 300*time.Millisecond)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}

// runServiceLauncher is what pkexec actually runs (see src/main/tunnel/linux/serviceStart.ts): the app
// starts the service exactly like it starts the Windows one with `sc.exe start` — a call that returns
// once the service is really up, not one that blocks for as long as the service runs. A Go process
// cannot safely fork(2) itself (its own runtime uses threads), so instead this re-execs itself with
// `--daemon` as a detached child and waits for that child's socket to answer.
func runServiceLauncher() int {
	if socketAnswers() {
		return 0 // already running: sc.exe's own ERROR_SERVICE_ALREADY_RUNNING, accepted the same way
	}
	self, err := os.Executable()
	if err != nil {
		fmt.Fprintln(os.Stderr, "service:", err)
		return 1
	}
	devnull, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		fmt.Fprintln(os.Stderr, "service:", err)
		return 1
	}
	defer devnull.Close()

	cmd := exec.Command(self, "service", "--daemon")
	cmd.Stdin, cmd.Stdout, cmd.Stderr = devnull, devnull, devnull
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		fmt.Fprintln(os.Stderr, "service:", err)
		return 1
	}
	go func() { _ = cmd.Wait() }() // reap: nothing else is this process's parent

	deadline := time.Now().Add(launchDeadline)
	for time.Now().Before(deadline) {
		if socketAnswers() {
			return 0
		}
		time.Sleep(50 * time.Millisecond)
	}
	fmt.Fprintln(os.Stderr, "service: не успела запуститься за отведённое время")
	return 1
}

// runServiceDaemon is the service for real: it owns the socket the app talks to, and stops once the
// app is gone (internal/lifetime) or a signal asks it to (`remove`'s stop step, setup_linux.go's
// stopRunningService, or a signal sent by hand).
func runServiceDaemon() int {
	d := layout()
	if err := os.MkdirAll(d.run, 0o755); err != nil {
		fmt.Fprintln(os.Stderr, "service:", err)
		return 1
	}
	if err := os.MkdirAll(d.lib, 0o700); err != nil {
		fmt.Fprintln(os.Stderr, "service:", err)
		return 1
	}
	if err := os.WriteFile(servicePIDPath(), []byte(strconv.Itoa(os.Getpid())), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "service:", err)
		return 1
	}
	defer os.Remove(servicePIDPath())

	life := lifetime.New(awaitExit)
	c := newController(d, life)
	c.reconcile()

	l, err := listenSocket(socketPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "service:", err)
		return 1
	}
	go serve(c, l)
	life.Idle(idleTimeout)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	select {
	case <-sig:
	case <-life.Done():
	}
	life.Close()
	l.Close()
	_ = os.Remove(socketPath)
	c.mu.Lock()
	c.teardownLocked()
	c.mu.Unlock()
	return 0
}
