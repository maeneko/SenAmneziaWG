package main

import (
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
)

const (
	productName        = "SenAWG"
	managerServiceName = "SenAWGHelper"
	// One tunnel at a time, so the adapter, the .conf and the tunnel service share a fixed name. It must
	// satisfy conf.TunnelNameIsValid: the fork derives the service name and the UAPI pipe from it.
	tunnelName = "SenAWG"
	// Under ProtectedPrefix\Administrators only an administrator (or SYSTEM) can create a pipe, so a user
	// cannot occupy the name first and receive the private key the app sends with `up`. The same
	// pattern wireguard-windows uses for its own manager pipe.
	helperPipe = `\\.\pipe\ProtectedPrefix\Administrators\SenAWG\helper`
)

// dirs is everything the helper keeps on disk, under C:\ProgramData\SenAWG:
//
//	daemon.log   the tunnel's log, world-readable: the app follows it without privileges
//	data\        SYSTEM and Administrators only: the ring log, state, and the .conf holding the private key
type dirs struct{ base, data, tunnels string }

func layout() (dirs, error) {
	pd, err := windows.KnownFolderPath(windows.FOLDERID_ProgramData, windows.KF_FLAG_DEFAULT)
	if err != nil {
		return dirs{}, err
	}
	base := filepath.Join(pd, productName)
	data := filepath.Join(base, "data")
	return dirs{base: base, data: data, tunnels: filepath.Join(data, "tunnels")}, nil
}

func (d dirs) confPath() string  { return filepath.Join(d.tunnels, tunnelName+".conf") }
func (d dirs) statePath() string { return filepath.Join(d.data, "state.json") }
func (d dirs) ringPath() string  { return filepath.Join(d.data, "log.bin") }
func (d dirs) daemonLog() string { return filepath.Join(d.base, "daemon.log") }

func exists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}
