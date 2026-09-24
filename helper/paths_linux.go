//go:build linux

package main

import "path/filepath"

const (
	// One tunnel at a time (as on Windows and macOS), so the interface has a fixed name.
	tunnelName = "senawg0"
	// 0666: like the Windows pipe's IU right, any local user may talk to the service; the daemon's own
	// UAPI socket underneath is root-only, so nothing but the service itself ever holds the private key.
	socketPath = "/run/senawg/helper.sock"
	// The polkit action that lets the app start the service without a password (installed by `setup`).
	polkitAction = "ru.senawg.helper.service"
)

// dirs is everything the helper keeps on disk.
//
//	/run/senawg/daemon.log   the daemon's log, world-readable: the app follows it without privileges
//	/var/lib/senawg/         root only: state.json (the running tunnel) and a DNS backup, if one was made
//	/var/lib/senawg/secrets/ root only: tunnel keys, when the desktop has no keyring (internal/vault)
type dirs struct{ run, lib string }

func layout() dirs { return dirs{run: "/run/senawg", lib: "/var/lib/senawg"} }

func (d dirs) daemonLog() string  { return filepath.Join(d.run, "daemon.log") }
func (d dirs) statePath() string  { return filepath.Join(d.lib, "state.json") }
func (d dirs) resolvBak() string  { return filepath.Join(d.lib, "resolv.conf.bak") }
func (d dirs) secretsDir() string { return filepath.Join(d.lib, "secrets") }
