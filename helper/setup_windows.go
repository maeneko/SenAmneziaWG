package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
	"senawg-helper/internal/setup"
)

// wintunSHA256 is the hash of the wintun.dll that belongs to this build, set by scripts/build-helper-win.mjs
// (-X main.wintunSHA256=…). The service loads that DLL as SYSTEM, and setup reads it from a folder the
// user can write to, so it is checked against this before it goes under Program Files.
var wintunSHA256 string

const (
	appKey       = `SOFTWARE\SenAWG`
	uninstallKey = `SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\SenAWG`
	readyTimeout = 20 * time.Second
)

// serviceDir is where the service's own files live: the one place a SYSTEM service may run from.
func serviceDir() (string, error) {
	pf, err := windows.KnownFolderPath(windows.FOLDERID_ProgramFiles, windows.KF_FLAG_DEFAULT)
	if err != nil {
		return "", err
	}
	return filepath.Join(pf, productName), nil
}

// runSetup is `awg-helper setup`, what the application runs (elevated) when the user presses «Установить»:
// the three steps of the setup screen, and the way back if any of them fails.
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

	step, fresh, err := doSetup(a, rep)
	if err != nil {
		msg := err.Error()
		if fresh {
			msg += " Изменения отменены."
		}
		rep.Fail(step, msg)
		fmt.Fprintln(os.Stderr, "setup:", err)
		return 1
	}
	return 0
}

// doSetup returns the step that failed and whether the machine was clean before (so that everything was
// taken back). An update over an existing install cannot be taken back — the old files are overwritten —
// and the service it leaves is the one that was there.
func doSetup(a setup.Args, rep *setup.Reporter) (failedStep int, fresh bool, err error) {
	var undo []func()
	defer func() {
		if err != nil {
			for i := len(undo) - 1; i >= 0; i-- {
				undo[i]()
			}
		}
	}()

	self, err := os.Executable()
	if err != nil {
		return setup.StepFiles, false, err
	}
	svcDir, err := serviceDir()
	if err != nil {
		return setup.StepFiles, false, err
	}
	appDir := setup.AppDir(a.To)
	if !filepath.IsAbs(appDir) || filepath.Dir(appDir) == appDir {
		return setup.StepFiles, false, fmt.Errorf("«%s» не подходит для установки — выберите папку на диске", a.To)
	}

	prev := readAppPath()
	fresh = prev == "" && !serviceExists()

	// ── 1. Файлы программы ──
	failedStep = setup.StepFiles
	rep.Active(setup.StepFiles)
	seamless := a.UpdateWaitPID != 0 && !fresh && filepath.IsAbs(appDir) && strings.EqualFold(setup.AppDir(prev), appDir)
	if seamless {
		// The slow part first, beside the running application; only the swap needs it closed.
		if err = setup.Stage(a.From, appDir); err != nil {
			return failedStep, fresh, fmt.Errorf("не удалось подготовить новую версию в %s: %w", appDir, err)
		}
		undo = append(undo, func() { setup.DiscardStage(appDir) })
		rep.Staged()
		if !waitGone(a.UpdateWaitPID, waitOldTimeout) {
			return failedStep, fresh, errors.New("приложение не закрылось, обновление отменено")
		}
	}
	if !fresh {
		// An update: the running app and service hold the files about to be replaced.
		stopManagerService()
		if prev != "" {
			killProcessesUnder(prev)
		}
		killProcessesUnder(svcDir)
	}
	if seamless {
		// Undo runs newest first: the folders go back, and only then is the old service started again.
		undo = append(undo, func() { _ = installService(filepath.Join(svcDir, "awg-helper.exe"), false) })
		var rollback func()
		if rollback, err = setup.Swap(appDir); err != nil {
			return failedStep, fresh, err
		}
		undo = append(undo, rollback)
	} else {
		made, merr := setup.MkdirAllTracked(appDir)
		undo = append(undo, func() { setup.Undo(made) })
		if merr != nil {
			return failedStep, fresh, fmt.Errorf("не удалось создать папку %s: %w", appDir, merr)
		}
		copied, cerr := setup.CopyTree(a.From, appDir)
		undo = append(undo, func() { setup.Undo(copied) })
		if cerr != nil {
			return failedStep, fresh, fmt.Errorf("не удалось скопировать файлы программы в %s: %w", appDir, cerr)
		}
	}
	rep.Done(setup.StepFiles)

	// ── 2. Служба подключения ──
	failedStep = setup.StepService
	rep.Active(setup.StepService)
	madeSvc, err := setup.MkdirAllTracked(svcDir)
	undo = append(undo, func() { setup.Undo(madeSvc) })
	if err != nil {
		return failedStep, fresh, fmt.Errorf("не удалось создать папку %s: %w", svcDir, err)
	}
	helperExe := filepath.Join(svcDir, "awg-helper.exe")
	dll := filepath.Join(svcDir, "wintun.dll")
	if err = installServiceFiles(self, helperExe, dll, &undo); err != nil {
		return failedStep, fresh, err
	}
	undo = append(undo, func() {
		if fresh {
			_ = uninstallManager()
		}
	})
	if err = installService(helperExe, false); err != nil && !errors.Is(err, windows.ERROR_SERVICE_ALREADY_RUNNING) {
		return failedStep, fresh, fmt.Errorf("не удалось установить службу SenAWG: %w", err)
	}
	err = nil
	undo = append(undo, func() {
		if fresh {
			unregister()
		}
	})
	if err = register(appDir, helperExe); err != nil {
		return failedStep, fresh, fmt.Errorf("не удалось записать установку в реестр: %w", err)
	}
	rep.Done(setup.StepService)

	// ── 3. Запуск службы ──
	failedStep = setup.StepStart
	rep.Active(setup.StepStart)
	if err = waitReady(readyTimeout); err != nil {
		return failedStep, fresh, err
	}
	rep.Done(setup.StepStart)
	if seamless {
		setup.DiscardOld(appDir)
	}
	return 0, fresh, nil
}

// installServiceFiles puts awg-helper.exe (this very executable: the one the user approved in the UAC
// prompt, which cannot be modified while it runs) and a verified wintun.dll under Program Files.
func installServiceFiles(self, helperExe, dll string, undo *[]func()) error {
	if wintunSHA256 == "" {
		return errors.New("эта сборка не знает хеш wintun.dll — пересоберите её через npm run build:helper")
	}
	// Read once, check, write the same bytes: nothing can swap the file between the check and the copy.
	body, err := os.ReadFile(filepath.Join(filepath.Dir(self), "wintun.dll"))
	if err != nil {
		return fmt.Errorf("в установке нет wintun.dll: %w", err)
	}
	if sum := sha256.Sum256(body); !strings.EqualFold(hex.EncodeToString(sum[:]), wintunSHA256) {
		return errors.New("wintun.dll не совпадает с ожидаемым — установочные файлы повреждены или подменены")
	}
	for _, f := range []string{helperExe, dll} {
		if !exists(f) {
			f := f
			*undo = append(*undo, func() { _ = os.Remove(f) })
		}
	}
	if !strings.EqualFold(filepath.Clean(self), filepath.Clean(helperExe)) {
		if err := copyOverSelf(self, helperExe); err != nil {
			return fmt.Errorf("не удалось скопировать службу в %s: %w", filepath.Dir(helperExe), err)
		}
	}
	if err := os.WriteFile(dll, body, 0o644); err != nil {
		return fmt.Errorf("не удалось записать wintun.dll: %w", err)
	}
	return nil
}

func copyOverSelf(from, to string) error {
	in, err := os.ReadFile(from)
	if err != nil {
		return err
	}
	return os.WriteFile(to, in, 0o755)
}

func serviceExists() bool {
	m, err := mgr.Connect()
	if err != nil {
		return false
	}
	defer m.Disconnect()
	s, err := m.OpenService(managerServiceName)
	if err != nil {
		return false
	}
	s.Close()
	return true
}

func stopManagerService() {
	m, err := mgr.Connect()
	if err != nil {
		return
	}
	defer m.Disconnect()
	if s, err := m.OpenService(managerServiceName); err == nil {
		stopService(s)
		s.Close()
	}
}

// waitReady is the third step for real: the service is RUNNING and its pipe accepts connections — the
// thing the app will actually use. `install` only asks the SCM to start it and returns.
func waitReady(timeout time.Duration) error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(managerServiceName)
	if err != nil {
		return fmt.Errorf("служба SenAWG не найдена: %w", err)
	}
	defer s.Close()
	pipe, err := windows.UTF16PtrFromString(helperPipe)
	if err != nil {
		return err
	}
	for deadline := time.Now().Add(timeout); time.Now().Before(deadline); time.Sleep(poll) {
		st, err := s.Query()
		if err != nil {
			return err
		}
		if st.State == svc.Stopped {
			return errors.New("служба SenAWG остановилась сразу после запуска — причину смотрите в «Просмотре событий», источник SenAWGHelper")
		}
		if st.State == svc.Running && pipeAnswers(pipe) {
			return nil
		}
	}
	return errors.New("служба SenAWG не успела запуститься")
}

var waitNamedPipe = windows.NewLazySystemDLL("kernel32.dll").NewProc("WaitNamedPipeW")

// pipeAnswers reports whether a server is listening on the pipe, without connecting to it: connecting
// and hanging up would look to the service like a client that sent nothing.
func pipeAnswers(name *uint16) bool {
	r, _, _ := waitNamedPipe.Call(uintptr(unsafe.Pointer(name)), 100)
	return r != 0
}

// ── Registration: what «Программы и компоненты» and the next update read ──

func readAppPath() string {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, appKey, registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer k.Close()
	v, _, err := k.GetStringValue("AppPath")
	if err != nil {
		return ""
	}
	return v
}

func register(appDir, helperExe string) error {
	k, _, err := registry.CreateKey(registry.LOCAL_MACHINE, appKey, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	if err := k.SetStringValue("AppPath", appDir); err != nil {
		return err
	}

	u, _, err := registry.CreateKey(registry.LOCAL_MACHINE, uninstallKey, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer u.Close()
	for name, value := range map[string]string{
		"DisplayName":     productName,
		"DisplayVersion":  version,
		"Publisher":       productName,
		"InstallLocation": appDir,
		"DisplayIcon":     filepath.Join(appDir, productName+".exe"),
		"UninstallString": windows.EscapeArg(helperExe) + " remove",
	} {
		if err := u.SetStringValue(name, value); err != nil {
			return err
		}
	}
	for _, name := range []string{"NoModify", "NoRepair"} {
		if err := u.SetDWordValue(name, 1); err != nil {
			return err
		}
	}
	return nil
}

func unregister() {
	_ = registry.DeleteKey(registry.LOCAL_MACHINE, uninstallKey)
	_ = registry.DeleteKey(registry.LOCAL_MACHINE, appKey)
}
