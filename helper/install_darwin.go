//go:build darwin

package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"senawg-helper/internal/setup"
)

// bootstrapWait: launchd opens the job's socket as part of bootstrap; this is only a margin for a busy Mac.
const bootstrapWait = 3 * time.Second

// runInstall is `awg-helper install --from <Contents/Resources>`: what the app runs once, behind the one
// admin prompt it still takes (and again when an update brings a different service, see buildID). It
// copies the service out of the app bundle — which the user can write to — into a directory only root
// can, and hands it to launchd. A running tunnel is left alone: it belongs to awg.sh, not the service.
func runInstall(args []string) int {
	if len(args) != 2 || args[0] != "--from" || !filepath.IsAbs(args[1]) {
		fmt.Fprintln(os.Stderr, "usage: awg-helper install --from <Contents/Resources>")
		return 2
	}
	if err := install(filepath.Clean(args[1])); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

func install(resources string) error {
	if os.Geteuid() != 0 {
		return errors.New("установка службы SenAWG требует прав администратора")
	}
	if err := os.MkdirAll(filepath.Dir(installTarget), 0o755); err != nil {
		return err
	}
	// Everything that can fail on the way in happens before the running service is touched.
	if err := stageService(resources, installTarget); err != nil {
		return err
	}
	oldPlist, oldPlistErr := os.ReadFile(plistPath)
	_, statErr := os.Stat(installTarget)
	hadOld := statErr == nil

	bootout()
	rollback, err := setup.Swap(installTarget)
	if err != nil {
		setup.DiscardStage(installTarget)
		_ = bootstrap() // the previous service, if there was one, back as it was
		return err
	}
	// Back to exactly what was there: the previous service, files and plist, running again — or nothing.
	undo := func() {
		bootout()
		if hadOld {
			rollback()
		} else {
			_ = os.RemoveAll(installTarget)
		}
		if oldPlistErr == nil {
			_ = writeRootFile(plistPath, string(oldPlist))
			_ = bootstrap()
		} else {
			_ = os.Remove(plistPath)
		}
	}
	if err := checkInstall(installTarget); err != nil {
		undo()
		return err
	}
	if err := writeRootFile(plistPath, servicePlist(filepath.Join(installTarget, "awg-helper"), socketPath, serviceStderrLog)); err != nil {
		undo()
		return fmt.Errorf("не удалось записать %s: %w", plistPath, err)
	}
	// Undoes a `launchctl disable` left from before; Login Items' own switch is the user's, and when it
	// is off, bootstrap fails and says so.
	_ = launchctl("enable", "system/"+serviceLabel)
	if err := bootstrap(); err != nil {
		undo()
		return fmt.Errorf("launchd не принял службу SenAWG (%v). Если она выключена в Системных настройках → "+
			"Основные → Объекты входа, включите её и подключитесь снова", err)
	}
	if !waitFor(func() bool { _, err := os.Stat(socketPath); return err == nil }, bootstrapWait) {
		undo()
		return errors.New("служба SenAWG установлена, но launchd не открыл её сокет")
	}
	setup.DiscardOld(installTarget)
	return nil
}

// runUninstall is `awg-helper uninstall`, the reverse of install: the tunnel down if one runs (awg.sh
// down, as disconnecting does), the job out of launchd, and every file the service and awg.sh keep.
func runUninstall(args []string) int {
	if len(args) != 0 {
		fmt.Fprintln(os.Stderr, "usage: awg-helper uninstall")
		return 2
	}
	if os.Geteuid() != 0 {
		fmt.Fprintln(os.Stderr, "удаление службы SenAWG требует прав администратора")
		return 1
	}
	if _, err := os.Stat(stateFilePath()); err == nil && checkInstall(installTarget) == nil {
		out, err := exec.Command("/bin/bash", filepath.Join(installTarget, "awg.sh"), "down").CombinedOutput()
		if err != nil {
			fmt.Fprintf(os.Stderr, "туннель не остановлен: %s\n", strings.TrimSpace(string(out)))
		}
	}
	bootout()
	remove := []string{plistPath, installTarget, setup.NextDir(installTarget), setup.OldDir(installTarget), socketPath, serviceStderrLog}
	// state.env still there means a tunnel was not taken down: without it nothing could later undo its
	// DNS and route to the server, so awg.sh's directory stays until someone disconnects it.
	if _, err := os.Stat(stateFilePath()); os.IsNotExist(err) {
		remove = append(remove, stateDir)
	} else {
		fmt.Fprintf(os.Stderr, "%s оставлен: в нём состояние работающего туннеля\n", stateDir)
	}
	var failed bool
	for _, path := range remove {
		if err := os.RemoveAll(path); err != nil {
			fmt.Fprintln(os.Stderr, err)
			failed = true
		}
	}
	if failed {
		return 1
	}
	return 0
}

func launchctl(args ...string) error {
	out, err := exec.Command("/bin/launchctl", args...).CombinedOutput()
	if err != nil {
		if msg := strings.TrimSpace(string(out)); msg != "" {
			return errors.New(msg)
		}
		return err
	}
	return nil
}

// bootout stops the job and takes it out of launchd; it not being there is not an error.
func bootout() {
	_ = launchctl("bootout", "system/"+serviceLabel)
	waitFor(func() bool { return launchctl("print", "system/"+serviceLabel) != nil }, bootstrapWait)
}

func bootstrap() error {
	if _, err := os.Stat(plistPath); err != nil {
		return err
	}
	return launchctl("bootstrap", "system", plistPath)
}

// writeRootFile replaces path in one rename, 0644: launchd reads plists only when root owns them and
// nobody else can write them.
func writeRootFile(path, content string) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(content), 0o644); err != nil {
		return err
	}
	if err := os.Chmod(tmp, 0o644); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

func waitFor(ok func() bool, timeout time.Duration) bool {
	for deadline := time.Now().Add(timeout); ; time.Sleep(50 * time.Millisecond) {
		if ok() {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
	}
}
