package main

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/amnezia-vpn/amneziawg-windows/v3/conf"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/eventlog"
	"golang.org/x/sys/windows/svc/mgr"

	"senawg-helper/internal/lifetime"
)

// reportFailure leaves the reason a service could not start where an administrator will look for it:
// Event Viewer → Windows Logs → Application, source SenAWGHelper.
func reportFailure(err error) {
	if elog, e := eventlog.Open(managerServiceName); e == nil {
		defer elog.Close()
		_ = elog.Error(1, "Служба не запустилась: "+err.Error())
	}
}

// managerService is the LocalSystem service the installer registers: it owns the pipe the app talks to.
// It is started on demand by the app and stops by itself once the app is gone (internal/lifetime).
type managerService struct{}

// idleTimeout: how long a service nobody has talked to waits for the app before stopping. Long enough
// for an installer to hand over to the app it has just installed.
const idleTimeout = 60 * time.Second

// serviceSDDL is the default ACL of a service plus one entry: interactive users (the same circle that
// may write to the pipe) may start it and query it, but not stop or reconfigure it. RP is SERVICE_START.
const serviceSDDL = "D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWRPLOCRRC;;;IU)"

type helper struct {
	c      *controller
	l      net.Listener
	mirror *logMirror
}

func startHelper() (*helper, error) {
	d, err := layout()
	if err != nil {
		return nil, err
	}
	if err := d.ensure(); err != nil {
		return nil, err
	}
	// The fork keeps its ring log under this root; pointing it here keeps everything in one place.
	conf.PresetRootDirectory(d.data)
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	mirror, err := newLogMirror(d)
	if err != nil {
		return nil, err
	}
	c := &controller{d: d, exe: exe, mirror: mirror, life: lifetime.New(awaitExit)}
	c.reconcile()
	l, err := listenPipe()
	if err != nil {
		mirror.Close()
		return nil, err
	}
	go serve(c, l)
	c.life.Idle(idleTimeout)
	mirror.Note("служба запущена, " + version)
	return &helper{c: c, l: l, mirror: mirror}, nil
}

// stop takes the tunnel down with the service: a tunnel nobody manages is worse than none.
func (h *helper) stop() {
	h.c.life.Close()
	h.l.Close()
	h.c.mu.Lock()
	h.c.teardownLocked()
	h.c.mu.Unlock()
	h.mirror.Close()
}

func (managerService) Execute(_ []string, requests <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	changes <- svc.Status{State: svc.StartPending}
	h, err := startHelper()
	if err != nil {
		reportFailure(err)
		return true, 1
	}
	changes <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for {
		select {
		case req, ok := <-requests:
			if !ok {
				return false, 0
			}
			switch req.Cmd {
			case svc.Interrogate:
				changes <- req.CurrentStatus
			case svc.Stop, svc.Shutdown:
				return h.stopReporting(changes)
			}
		case why := <-h.c.life.Done():
			// Exit code 0: a service that stopped by itself is not a failure, so the recovery actions
			// (which restart it) do not fire.
			h.mirror.Note(why)
			return h.stopReporting(changes)
		}
	}
}

// stopReporting stops the helper. That means taking the tunnel down, which takes seconds, and a service
// that goes quiet during that is treated as hung: it is left in «Stopping» and its process stays behind.
// So keep reporting progress until the teardown is really finished.
func (h *helper) stopReporting(changes chan<- svc.Status) (bool, uint32) {
	done := make(chan struct{})
	go func() {
		defer close(done)
		h.stop()
	}()
	progress := svc.Status{State: svc.StopPending, WaitHint: 5000, CheckPoint: 1}
	changes <- progress
	t := time.NewTicker(2 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-done:
			return false, 0
		case <-t.C:
			progress.CheckPoint++
			changes <- progress
		}
	}
}

// --- install / uninstall: called by the installer, elevated -------------------------------------------

// requireProtectedPath: the service runs this executable as SYSTEM, so whoever can replace the file can
// run code as SYSTEM. Under Program Files only administrators can.
func requireProtectedPath(exe string) error {
	pf, err := windows.KnownFolderPath(windows.FOLDERID_ProgramFiles, windows.KF_FLAG_DEFAULT)
	if err != nil {
		return err
	}
	if !strings.HasPrefix(strings.ToLower(filepath.Clean(exe)), strings.ToLower(filepath.Clean(pf))+`\`) {
		return fmt.Errorf("%s лежит вне %s: служба работает от SYSTEM, и из каталога, доступного пользователю, "+
			"её файл мог бы подменить любой (для разработки: install --dev)", exe, pf)
	}
	return nil
}

func installManager(dev bool) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	return installService(exe, dev)
}

// installService registers exe as the service and starts it. `setup` calls it for the copy it has just
// put under Program Files, not for itself — it runs from the unpacked installer, which is not a place
// a SYSTEM service may run from.
func installService(exe string, dev bool) error {
	if !dev {
		if err := requireProtectedPath(exe); err != nil {
			return err
		}
	}
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()

	s, err := m.OpenService(managerServiceName)
	if err == nil {
		// Reinstall over an existing one (an update): stop it, point it at this executable.
		stopService(s)
		cfg, cerr := s.Config()
		if cerr != nil {
			s.Close()
			return cerr
		}
		cfg.BinaryPathName = windows.EscapeArg(exe) + " service"
		// Installs from before the app started the service itself had it start with Windows.
		cfg.StartType = mgr.StartManual
		if err = s.UpdateConfig(cfg); err != nil {
			s.Close()
			return err
		}
	} else {
		s, err = m.CreateService(managerServiceName, exe, mgr.Config{
			ServiceType:  windows.SERVICE_WIN32_OWN_PROCESS,
			StartType:    mgr.StartManual, // the app starts it; it stops once the app is gone
			ErrorControl: mgr.ErrorNormal,
			DisplayName:  "SenAWG Helper",
			Description:  "Управляет VPN-туннелем SenAWG, чтобы приложению не нужны были права администратора",
		}, "service")
		if err != nil {
			return err
		}
	}
	defer s.Close()

	if err := allowUsersToStart(s); err != nil {
		return fmt.Errorf("не удалось разрешить приложению запускать службу: %w", err)
	}
	_ = eventlog.InstallAsEventCreate(managerServiceName, eventlog.Error|eventlog.Warning|eventlog.Info)
	// If it crashes, bring it back: the app cannot connect without it. A restarted service with no app
	// left to serve stops again after idleTimeout.
	_ = s.SetRecoveryActions([]mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: 5 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 30 * time.Second},
		{Type: mgr.NoAction},
	}, 24*60*60)
	return s.Start()
}

// allowUsersToStart lets the unelevated app start the service, which is what makes on-demand start
// possible without a UAC prompt on every launch.
func allowUsersToStart(s *mgr.Service) error {
	sd, err := windows.SecurityDescriptorFromString(serviceSDDL)
	if err != nil {
		return err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	return windows.SetSecurityInfo(s.Handle, windows.SE_SERVICE, windows.DACL_SECURITY_INFORMATION, nil, nil, dacl, nil)
}

func uninstallManager() error {
	// Stopping the manager takes its tunnel down; a tunnel service left registered is removed below.
	if m, err := mgr.Connect(); err == nil {
		defer m.Disconnect()
		if s, err := m.OpenService(managerServiceName); err == nil {
			stopService(s)
			_ = s.Delete()
			s.Close()
		}
		if s, err := m.OpenService(tunnelService()); err == nil {
			stopService(s)
			_ = s.Delete()
			s.Close()
		}
	} else {
		return err
	}
	_ = eventlog.Remove(managerServiceName)
	if d, err := layout(); err == nil {
		// Give the SCM a moment to release the log the service had open.
		for i := 0; i < 10; i++ {
			if err := os.RemoveAll(d.base); err == nil || errors.Is(err, os.ErrNotExist) {
				break
			}
			time.Sleep(poll)
		}
	}
	return nil
}

func stopService(s *mgr.Service) {
	if status, err := s.Query(); err != nil || status.State == svc.Stopped {
		return
	}
	_, _ = s.Control(svc.Stop)
	for deadline := time.Now().Add(stopTimeout); time.Now().Before(deadline); time.Sleep(poll) {
		if status, err := s.Query(); err != nil || status.State == svc.Stopped {
			return
		}
	}
}
