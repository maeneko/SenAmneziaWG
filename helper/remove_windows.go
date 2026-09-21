package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/windows"

	"senawg-helper/internal/setup"
)

// runRemove is `awg-helper remove`. Two callers:
//
//   - «Программы и компоненты» (the UninstallString): started without rights, so it asks for them first;
//     it closes the running application, and it tells the outcome in a message box.
//   - the application itself (`--progress`), already elevated through runElevated: the application stays
//     on screen and shows the steps, so it is reported to and left running; its own folder is removed
//     only once it has exited («Завершить»).
//
// Either way the installed copy cannot delete the file it runs from, so it hands over to a copy in %TEMP%
// that finishes the job.
func runRemove(args []string) int {
	a, err := setup.ParseRemoveArgs(args)
	if err != nil {
		fmt.Fprintln(os.Stderr, "remove:", err)
		return 2
	}
	if !windows.GetCurrentProcessToken().IsElevated() {
		return relaunchElevated(append([]string{"remove"}, args...))
	}
	rep, err := setup.NewReporter(a.Progress)
	if err != nil {
		fmt.Fprintln(os.Stderr, "remove:", err)
		return 2
	}
	defer rep.Close()
	r := &remover{a: a, rep: rep}

	self, err := os.Executable()
	if err != nil {
		return r.failed(setup.RemoveStepStop, err)
	}
	svcDir, err := serviceDir()
	if err != nil {
		return r.failed(setup.RemoveStepStop, err)
	}
	inService := strings.HasPrefix(strings.ToLower(self), strings.ToLower(svcDir)+`\`)
	if inService && !a.Finish {
		return r.handOver(self)
	}
	return r.finish(self, svcDir, inService)
}

type remover struct {
	a   setup.RemoveArgs
	rep *setup.Reporter
}

// inApp: the application runs the removal and shows it.
func (r *remover) inApp() bool { return r.a.Progress != "" }

// failed tells whoever is there: the application's screen, or a message box.
func (r *remover) failed(step int, err error) int {
	fmt.Fprintln(os.Stderr, "remove:", err)
	if r.inApp() {
		r.rep.Fail(step, err.Error())
	} else {
		message("Не удалось удалить SenAWG: "+err.Error(), windows.MB_ICONERROR)
	}
	return 1
}

func relaunchElevated(args []string) int {
	self, err := os.Executable()
	if err != nil {
		message("Не удалось удалить SenAWG: "+err.Error(), windows.MB_ICONERROR)
		return 1
	}
	verb, _ := windows.UTF16PtrFromString("runas")
	exe, _ := windows.UTF16PtrFromString(self)
	params, _ := windows.UTF16PtrFromString(windows.ComposeCommandLine(args))
	if err := windows.ShellExecute(0, verb, exe, params, nil, windows.SW_HIDE); err != nil {
		// Refusing the UAC prompt lands here too: the user changed their mind, nothing was touched.
		return 1
	}
	return 0
}

func (r *remover) handOver(self string) int {
	tmp, err := os.MkdirTemp("", "awg-remove-")
	if err != nil {
		return r.failed(setup.RemoveStepStop, err)
	}
	copy := filepath.Join(tmp, "awg-helper.exe")
	if err := copyOverSelf(self, copy); err != nil {
		return r.failed(setup.RemoveStepStop, err)
	}
	finish := r.a
	finish.Finish = true
	cmd := exec.Command(copy, append([]string{"remove"}, finish.Args()...)...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
	if err := cmd.Start(); err != nil {
		return r.failed(setup.RemoveStepStop, err)
	}
	return 0
}

func (r *remover) finish(self, svcDir string, inService bool) int {
	app := readAppPath()
	// Only an application folder of our own name is ever removed (setup.AppDir always makes one), so this
	// cannot take anything of the user's with it — anything else is left rather than guessed at.
	ownApp := app != "" && strings.EqualFold(filepath.Base(app), productName) && filepath.Dir(app) != app

	// ── 1. Отключение и остановка службы ──
	r.rep.Active(setup.RemoveStepStop)
	stopManagerService()
	if app != "" && !r.inApp() {
		killProcessesUnder(app)
	}
	killProcessesUnder(svcDir)
	r.rep.Done(setup.RemoveStepStop)

	// ── 2. Служба подключения ──
	r.rep.Active(setup.RemoveStepService)
	if err := uninstallManager(); err != nil {
		return r.failed(setup.RemoveStepService, fmt.Errorf("не удалось удалить службу SenAWG: %w", err))
	}
	r.rep.Done(setup.RemoveStepService)

	// ── 3. Файлы программы ──
	r.rep.Active(setup.RemoveStepFiles)
	var stuck []string
	if ownApp && !r.inApp() {
		if err := removeAllRetry(app); err != nil {
			stuck = append(stuck, app)
		}
	}
	if err := removeAllRetry(svcDir); err != nil {
		stuck = append(stuck, svcDir)
	}
	unregister()
	if !r.inApp() {
		// In the user's own Start menu. From the app, the app removes it itself: this process may be
		// running as another account (an administrator's credentials typed into the prompt).
		if appData := os.Getenv("APPDATA"); appData != "" {
			_ = os.Remove(filepath.Join(appData, `Microsoft\Windows\Start Menu\Programs`, productName+".lnk"))
		}
	}
	if len(stuck) > 0 && r.inApp() {
		return r.failed(setup.RemoveStepFiles, fmt.Errorf("программа удалена, но не всё получилось стереть: %s. "+
			"Закройте программы, которые могли занять эти папки, и удалите их вручную", strings.Join(stuck, ", ")))
	}
	r.rep.Done(setup.RemoveStepFiles)

	// From the app: its folder goes once it has closed. Nobody is left to report to by then, so a folder
	// that will not go is told in a message box, as from «Программы и компоненты».
	if r.inApp() && ownApp {
		r.rep.Close()
		waitUntilNoProcessUnder(app)
		if err := removeAllRetry(app); err != nil {
			stuck = append(stuck, app)
		}
	}

	// The copy in %TEMP% cannot delete itself while it runs: a moment later, from outside.
	if !inService {
		dir := filepath.Dir(self)
		if strings.HasPrefix(strings.ToLower(filepath.Base(dir)), "awg-remove-") {
			c := exec.Command("cmd.exe", "/c", "timeout /t 3 /nobreak >nul & rmdir /s /q \""+dir+"\"")
			c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
			_ = c.Start()
		}
	}

	if len(stuck) > 0 {
		message("SenAWG удалён, но не всё получилось стереть: "+strings.Join(stuck, ", ")+
			". Закройте программы, которые могли занять эти папки, и удалите их вручную.", windows.MB_ICONWARNING)
		return 1
	}
	if !r.inApp() {
		message("SenAWG удалён.", windows.MB_ICONINFORMATION)
	}
	return 0
}

// Files of a process that has just been killed are released a moment later.
func removeAllRetry(dir string) error {
	var err error
	for i := 0; i < 15; i++ {
		if err = os.RemoveAll(dir); err == nil {
			return nil
		}
		time.Sleep(poll)
	}
	return err
}

func message(text string, icon uint32) {
	t, _ := windows.UTF16PtrFromString(text)
	c, _ := windows.UTF16PtrFromString(productName)
	_, _ = windows.MessageBox(0, t, c, windows.MB_OK|icon)
}
