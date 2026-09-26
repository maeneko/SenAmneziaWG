//go:build linux

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"senawg-helper/internal/setup"
)

const (
	polkitPolicyPath = "/usr/share/polkit-1/actions/ru.senawg.helper.policy"
	desktopPath      = "/usr/share/applications/senawg.desktop"
	iconPath         = "/usr/share/icons/hicolor/512x512/apps/senawg.png"
	installJSONPath  = "/etc/senawg/install.json"
	binSymlink       = "/usr/local/bin/senawg"
	// The app's own binary, as electron-builder's linux target names it (electron-builder.yml:
	// linux.executableName). Fixed, because the polkit action and the .desktop entry both need to
	// name an exact path.
	appExecutableName = "senawg"
)

// runSetup is `awg-helper setup`, what the application runs (elevated, via pkexec) when the user
// presses «Установить»: install.json's counterpart of what setup_windows.go writes to the registry, a
// polkit action in place of a service ACL, a .desktop entry in place of a Start-menu shortcut.
func runSetup(args []string) int {
	a, err := setup.ParseArgs(args)
	if err != nil {
		fmt.Fprintln(os.Stderr, "setup:", err)
		return 2
	}
	rep, err := setup.NewReporter(a.Progress)
	if err != nil {
		fmt.Fprintln(os.Stderr, "setup:", err)
		return 2
	}
	defer rep.Close()

	step, err := doSetup(a, rep)
	if err != nil {
		rep.Fail(step, err.Error())
		fmt.Fprintln(os.Stderr, "setup:", err)
		return 1
	}
	return 0
}

func doSetup(a setup.Args, rep *setup.Reporter) (failedStep int, err error) {
	if _, err := exec.LookPath("pkexec"); err != nil {
		return setup.StepFiles, errors.New("не найден pkexec (пакет polkit) — без него SenAWG не может подключаться без прав администратора при каждом разе")
	}

	appDir := filepath.Clean(a.To)
	if !filepath.IsAbs(appDir) || appDir == "/" {
		return setup.StepFiles, fmt.Errorf("«%s» не подходит для установки", a.To)
	}

	self, err := os.Executable()
	if err != nil {
		return setup.StepFiles, err
	}
	rel, err := filepath.Rel(a.From, self)
	if err != nil || strings.HasPrefix(rel, "..") {
		return setup.StepFiles, errors.New("этот awg-helper запущен не из распакованного каталога приложения")
	}
	installedHelper := filepath.Join(appDir, rel)
	installedApp := filepath.Join(appDir, appExecutableName)

	var undo []func()
	defer func() {
		if err != nil {
			for i := len(undo) - 1; i >= 0; i-- {
				undo[i]()
			}
		}
	}()

	// ── 1. Файлы программы ──
	failedStep = setup.StepFiles
	rep.Active(setup.StepFiles)
	prev, hadInstall := readInstallInfo()
	seamless := a.UpdateWaitPID != 0 && hadInstall && filepath.Clean(prev.AppPath) == appDir
	if seamless {
		// The slow part first, beside the running application; only the swap needs it closed.
		if err = setup.Stage(a.From, appDir); err != nil {
			return failedStep, fmt.Errorf("не удалось подготовить новую версию в %s: %w", appDir, err)
		}
		undo = append(undo, func() { setup.DiscardStage(appDir) })
		rep.Staged()
		if !waitGone(a.UpdateWaitPID, waitOldTimeout) {
			return failedStep, errors.New("приложение не закрылось, обновление отменено")
		}
	}
	// An update over a previous install: stop it first, so its files are not open underneath the copy.
	stopRunningService()
	if seamless {
		var rollback func()
		if rollback, err = setup.Swap(appDir); err != nil {
			return failedStep, err
		}
		undo = append(undo, rollback)
	} else {
		made, merr := setup.MkdirAllTracked(appDir)
		undo = append(undo, func() { setup.Undo(made) })
		if merr != nil {
			return failedStep, fmt.Errorf("не удалось создать папку %s: %w", appDir, merr)
		}
		copied, cerr := setup.CopyTree(a.From, appDir)
		undo = append(undo, func() { setup.Undo(copied) })
		if cerr != nil {
			return failedStep, fmt.Errorf("не удалось скопировать файлы программы в %s: %w", appDir, cerr)
		}
	}
	rep.Done(setup.StepFiles)

	// ── 2. Служба подключения ──
	failedStep = setup.StepService
	rep.Active(setup.StepService)
	if err = writePolkitPolicy(installedHelper); err != nil {
		return failedStep, fmt.Errorf("не удалось установить правило polkit: %w", err)
	}
	undo = append(undo, func() { _ = os.Remove(polkitPolicyPath) })
	writeDesktopEntry(installedApp) // best effort: a missing launcher entry is not fatal
	installIcon(appDir)             // best effort, same reasoning
	if err = register(appDir); err != nil {
		return failedStep, fmt.Errorf("не удалось записать установку: %w", err)
	}
	undo = append(undo, func() { _ = os.Remove(installJSONPath) })
	_ = os.Remove(binSymlink)
	_ = os.Symlink(installedApp, binSymlink)
	rep.Done(setup.StepService)

	// ── 3. Запуск службы ──
	failedStep = setup.StepStart
	rep.Active(setup.StepStart)
	// The service itself starts on demand, the first time the app connects (like Windows). What can be
	// verified now is that the binary just installed actually runs on this machine and architecture.
	out, verr := exec.Command(installedHelper, "version").CombinedOutput()
	if verr != nil {
		return failedStep, fmt.Errorf("установленный awg-helper не запускается: %w: %s", verr, strings.TrimSpace(string(out)))
	}
	rep.Done(setup.StepStart)
	if seamless {
		setup.DiscardOld(appDir)
	}
	return 0, nil
}

func writePolkitPolicy(helperPath string) error {
	if err := os.MkdirAll(filepath.Dir(polkitPolicyPath), 0o755); err != nil {
		return err
	}
	doc := strings.ReplaceAll(polkitPolicyTemplate, "{{HELPER}}", helperPath)
	return os.WriteFile(polkitPolicyPath, []byte(doc), 0o644)
}

// polkitPolicyTemplate lets an interactive user start the service without a password (it only opens a
// tunnel the same user could open some other way anyway) but requires an administrator for setup and
// remove, which touch /opt and system-wide files.
const polkitPolicyTemplate = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE policyconfig PUBLIC "-//freedesktop//DTD PolicyKit Policy Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/PolicyKit/1/policyconfig.dtd">
<policyconfig>
  <vendor>SenAWG</vendor>
  <action id="ru.senawg.helper.service">
    <description>Запуск службы подключения SenAWG</description>
    <message>Для подключения SenAWG нужны права администратора</message>
    <icon_name>network-vpn</icon_name>
    <defaults>
      <allow_any>no</allow_any>
      <allow_inactive>no</allow_inactive>
      <allow_active>yes</allow_active>
    </defaults>
    <annotate key="org.freedesktop.policykit.exec.path">{{HELPER}}</annotate>
  </action>
  <action id="ru.senawg.helper.setup">
    <description>Установка SenAWG</description>
    <message>Установка SenAWG требует прав администратора</message>
    <icon_name>network-vpn</icon_name>
    <defaults>
      <allow_any>auth_admin</allow_any>
      <allow_inactive>auth_admin</allow_inactive>
      <allow_active>auth_admin</allow_active>
    </defaults>
    <annotate key="org.freedesktop.policykit.exec.path">{{HELPER}}</annotate>
  </action>
  <action id="ru.senawg.helper.remove">
    <description>Удаление SenAWG</description>
    <message>Удаление SenAWG требует прав администратора</message>
    <icon_name>network-vpn</icon_name>
    <defaults>
      <allow_any>auth_admin</allow_any>
      <allow_inactive>auth_admin</allow_inactive>
      <allow_active>auth_admin</allow_active>
    </defaults>
    <annotate key="org.freedesktop.policykit.exec.path">{{HELPER}}</annotate>
  </action>
</policyconfig>
`

func writeDesktopEntry(installedApp string) {
	_ = os.MkdirAll(filepath.Dir(desktopPath), 0o755)
	doc := "[Desktop Entry]\n" +
		"Type=Application\n" +
		"Name=SenAWG\n" +
		"Exec=" + installedApp + " %U\n" +
		"Icon=senawg\n" +
		"Terminal=false\n" +
		"Categories=Network;\n"
	_ = os.WriteFile(desktopPath, []byte(doc), 0o644)
}

// installIcon puts the icon where the .desktop entry's Icon=senawg looks for it. It is the file the window
// and the tray use: electron-builder.yml ships build/icon.png as resources/linux/icon.png.
func installIcon(appDir string) {
	b, err := os.ReadFile(filepath.Join(appDir, "resources", "linux", "icon.png"))
	if err != nil {
		return // not fatal, just no icon in the menu
	}
	_ = os.MkdirAll(filepath.Dir(iconPath), 0o755)
	if os.WriteFile(iconPath, b, 0o644) != nil {
		return
	}
	// Where the distribution keeps an icon cache, the menu would not see the new icon until it is rebuilt.
	if tool, err := exec.LookPath("gtk-update-icon-cache"); err == nil {
		_ = exec.Command(tool, "-q", "-f", "-t", "/usr/share/icons/hicolor").Run()
	}
}

type installInfo struct {
	AppPath string `json:"appPath"`
	Version string `json:"version"`
}

func register(appDir string) error {
	if err := os.MkdirAll(filepath.Dir(installJSONPath), 0o755); err != nil {
		return err
	}
	b, err := json.Marshal(installInfo{AppPath: appDir, Version: version})
	if err != nil {
		return err
	}
	return os.WriteFile(installJSONPath, b, 0o644)
}

func readInstallInfo() (installInfo, bool) {
	b, err := os.ReadFile(installJSONPath)
	if err != nil {
		return installInfo{}, false
	}
	var info installInfo
	if json.Unmarshal(b, &info) != nil || info.AppPath == "" {
		return installInfo{}, false
	}
	return info, true
}

// stopRunningService terminates a service left by a previous install, the same way `remove`'s first
// step does (remove_linux.go): SIGTERM the pid it left behind and let its own signal handler tear the
// tunnel and its routing/DNS changes down before this process overwrites its files.
func stopRunningService() {
	pid, ok := readServicePID()
	if !ok {
		return
	}
	_ = terminate(pid)
	for i := 0; i < 20 && processAlive(uint32(pid)); i++ {
		time.Sleep(100 * time.Millisecond)
	}
}
