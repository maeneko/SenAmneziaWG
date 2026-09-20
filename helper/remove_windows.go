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
)

// runRemove is `awg-helper remove`, the UninstallString behind «Программы и компоненты». It is started
// without rights, so it asks for them first; and it cannot delete the file it is running from, so the
// installed copy hands over to a copy in %TEMP% that finishes the job.
func runRemove(args []string) int {
	if !windows.GetCurrentProcessToken().IsElevated() {
		return relaunchElevated(append([]string{"remove"}, args...))
	}
	self, err := os.Executable()
	if err != nil {
		return removeFailed(err)
	}
	svcDir, err := serviceDir()
	if err != nil {
		return removeFailed(err)
	}
	inService := strings.HasPrefix(strings.ToLower(self), strings.ToLower(svcDir)+`\`)
	if inService && !(len(args) > 0 && args[0] == "--finish") {
		return handOver(self)
	}
	return finishRemove(self, svcDir, inService)
}

func removeFailed(err error) int {
	fmt.Fprintln(os.Stderr, "remove:", err)
	message("Не удалось удалить AmnesiaWG: "+err.Error(), windows.MB_ICONERROR)
	return 1
}

func relaunchElevated(args []string) int {
	self, err := os.Executable()
	if err != nil {
		return removeFailed(err)
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

func handOver(self string) int {
	tmp, err := os.MkdirTemp("", "awg-remove-")
	if err != nil {
		return removeFailed(err)
	}
	copy := filepath.Join(tmp, "awg-helper.exe")
	if err := copyOverSelf(self, copy); err != nil {
		return removeFailed(err)
	}
	cmd := exec.Command(copy, "remove", "--finish")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
	if err := cmd.Start(); err != nil {
		return removeFailed(err)
	}
	return 0
}

func finishRemove(self, svcDir string, inService bool) int {
	app := readAppPath()
	stopManagerService()
	if app != "" {
		killProcessesUnder(app)
	}
	killProcessesUnder(svcDir)
	if err := uninstallManager(); err != nil {
		return removeFailed(err)
	}

	var stuck []string
	// The application is only ever installed into a folder named AmnesiaWG (setup.AppDir), so this cannot
	// take anything of the user's with it — and anything else is left rather than guessed at.
	if app != "" && strings.EqualFold(filepath.Base(app), productName) && filepath.Dir(app) != app {
		if err := removeAllRetry(app); err != nil {
			stuck = append(stuck, app)
		}
	}
	if err := removeAllRetry(svcDir); err != nil {
		stuck = append(stuck, svcDir)
	}
	unregister()
	if appData := os.Getenv("APPDATA"); appData != "" {
		_ = os.Remove(filepath.Join(appData, `Microsoft\Windows\Start Menu\Programs`, productName+".lnk"))
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
		message("AmnesiaWG удалён, но не всё получилось стереть: "+strings.Join(stuck, ", ")+
			". Закройте программы, которые могли занять эти папки, и удалите их вручную.", windows.MB_ICONWARNING)
		return 1
	}
	message("AmnesiaWG удалён.", windows.MB_ICONINFORMATION)
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
