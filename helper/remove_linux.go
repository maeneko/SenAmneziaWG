//go:build linux

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"senawg-helper/internal/setup"
)

// runRemove is `awg-helper remove`: the reverse of setup, run elevated (via pkexec, or `sudo` by hand).
// Unlike Windows, this executable can delete its own containing directory while it runs — Linux does
// not lock a file that is executing — so there is no hand-over to a copy elsewhere first.
func runRemove(args []string) int {
	a, err := setup.ParseRemoveArgs(args)
	if err != nil {
		fmt.Fprintln(os.Stderr, "remove:", err)
		return 2
	}
	rep, err := setup.NewReporter(a.Progress)
	if err != nil {
		fmt.Fprintln(os.Stderr, "remove:", err)
		return 2
	}
	defer rep.Close()

	rep.Active(setup.RemoveStepStop)
	stopRunningService()
	rep.Done(setup.RemoveStepStop)

	rep.Active(setup.RemoveStepService)
	for _, p := range []string{polkitPolicyPath, desktopPath, iconPath, installJSONPath, binSymlink} {
		_ = os.Remove(p)
	}
	rep.Done(setup.RemoveStepService)

	rep.Active(setup.RemoveStepFiles)
	if info, ok := readInstallInfo(); ok && info.AppPath != "" && info.AppPath != "/" {
		if err := removeAppDir(info.AppPath); err != nil {
			rep.Fail(setup.RemoveStepFiles, err.Error())
			fmt.Fprintln(os.Stderr, "remove:", err)
			return 1
		}
	}
	// The daemon's own log and state; harmless to remove even if nothing was running. The kept keys go
	// too, unless the user chose to keep their servers.
	removeLib(layout(), a.KeepSecrets)
	rep.Done(setup.RemoveStepFiles)
	return 0
}

func removeLib(d dirs, keepSecrets bool) {
	if !keepSecrets {
		_ = os.RemoveAll(d.lib)
		return
	}
	entries, _ := os.ReadDir(d.lib)
	for _, e := range entries {
		if p := filepath.Join(d.lib, e.Name()); p != d.secretsDir() {
			_ = os.RemoveAll(p)
		}
	}
}

// removeAppDir waits briefly for the just-stopped service process to actually release its files (the
// same margin stopRunningService already gives it) before deleting the directory it ran from.
func removeAppDir(appDir string) error {
	var err error
	for i := 0; i < 10; i++ {
		if err = os.RemoveAll(appDir); err == nil {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return err
}
