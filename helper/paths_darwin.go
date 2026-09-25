//go:build darwin

package main

import (
	"os"
	"path/filepath"
)

const (
	// The socket launchd opens for the service (servicePlist: Sockets → Listener) and hands it on first
	// connection. Straight in /var/run, which exists from boot, rather than in a folder of its own that
	// something would first have to create. 0666 like Linux's; refusePeer narrows who gets an answer.
	socketPath = "/var/run/ru.senawg.helper.sock"

	// The installed service: awg-helper, awg.sh and amneziawg-go (serviceFiles), root's only.
	installTarget = "/Library/PrivilegedHelperTools/" + serviceLabel
	plistPath     = "/Library/LaunchDaemons/" + serviceLabel + ".plist"
	// What the service prints before it can log to daemon.log (a socket launchd did not hand over).
	serviceStderrLog = "/var/log/" + serviceLabel + ".log"

	// awg.sh's own STATE_DIR: state.env (world-readable, what status reads), daemon.log and the
	// diagnostic captures. The service adds only its lines to daemon.log and short-lived body files.
	stateDir = "/var/db/senawg"
)

func stateFilePath() string { return filepath.Join(stateDir, "state.env") }
func daemonLogPath() string { return filepath.Join(stateDir, "daemon.log") }

// installDir is where the service runs from, with awg.sh and amneziawg-go beside it
// (/Library/PrivilegedHelperTools/ru.senawg.helper once installed). Never the app bundle: that is
// writable without root, and anything the service runs as root must not be (checkInstall).
func installDir() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		return "", err
	}
	return filepath.Dir(exe), nil
}
