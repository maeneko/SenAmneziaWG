//go:build linux

package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// runPty is `awg-helper pty <command> [args…]`: the command on a pseudo-terminal of its own, which is also
// its controlling terminal, relayed to this process's stdin and stdout; the exit code is the command's.
//
// src/main/setup/elevateLinux.ts runs pkexec this way when no polkit agent is running: pkexec's own text
// agent asks for the password only on a controlling terminal, and an application started from a menu
// has none. util-linux's `script -qefc` did this before, but it cannot be counted on — Artix ships one
// linked against libutempter without depending on it, so it does not even start. Unprivileged: the
// bytes are only passed along.
func runPty(args []string) int {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "usage: awg-helper pty <command> [args…]")
		return 2
	}
	// It runs whatever it is given, so it is never to run with rights it was handed: the app starts it
	// as the user, and pkexec in front of it would make it a root shell for anyone the policy lets through.
	if _, viaPkexec := os.LookupEnv("PKEXEC_UID"); viaPkexec || os.Geteuid() != os.Getuid() {
		fmt.Fprintln(os.Stderr, "pty: не запускается с повышенными правами")
		return 2
	}
	code, err := ptyRun(args, os.Stdin, os.Stdout)
	if err != nil {
		fmt.Fprintln(os.Stderr, "pty:", err)
		return 1
	}
	return code
}

// ptyDrain is how long the terminal is still read once the command has exited: enough for what it printed
// last, and a bound for when something it started (a detached service) keeps the terminal open forever.
const ptyDrain = 300 * time.Millisecond

func ptyRun(args []string, in io.Reader, out io.Writer) (int, error) {
	master, slave, err := openPty()
	if err != nil {
		return 0, err
	}
	defer master.Close()

	cmd := exec.Command(args[0], args[1:]...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = slave, slave, slave
	// A session of its own, with the terminal (the child's fd 0) as its controlling one: /dev/tty is it.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0}
	err = cmd.Start()
	slave.Close() // the child's copy is the one that matters: reading the master ends once it is gone
	if err != nil {
		return 0, err
	}

	go func() { _, _ = io.Copy(master, in) }()
	copied := make(chan struct{})
	go func() {
		_, _ = io.Copy(out, master) // ends with EIO when no one holds the terminal any more
		close(copied)
	}()

	waitErr := cmd.Wait()
	_ = master.SetReadDeadline(time.Now().Add(ptyDrain))
	select {
	case <-copied:
	case <-time.After(ptyDrain + 100*time.Millisecond):
	}

	var exit *exec.ExitError
	if errors.As(waitErr, &exit) {
		if ws, ok := exit.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
			return 128 + int(ws.Signal()), nil
		}
		return exit.ExitCode(), nil
	}
	return 0, waitErr
}

// openPty makes a new pseudo-terminal: its master, and the slave the command gets as its terminal.
func openPty() (master, slave *os.File, err error) {
	master, err = os.OpenFile("/dev/ptmx", os.O_RDWR|syscall.O_NOCTTY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, nil, err
	}
	var n int
	conn, err := master.SyscallConn()
	if err == nil {
		cerr := conn.Control(func(fd uintptr) {
			if err = unix.IoctlSetPointerInt(int(fd), unix.TIOCSPTLCK, 0); err != nil { // unlockpt
				return
			}
			n, err = unix.IoctlGetInt(int(fd), unix.TIOCGPTN) // ptsname
		})
		if err == nil {
			err = cerr
		}
	}
	if err != nil {
		master.Close()
		return nil, nil, fmt.Errorf("псевдотерминал: %w", err)
	}
	slave, err = os.OpenFile("/dev/pts/"+strconv.Itoa(n), os.O_RDWR|syscall.O_NOCTTY|syscall.O_CLOEXEC, 0)
	if err != nil {
		master.Close()
		return nil, nil, err
	}
	return master, slave, nil
}
