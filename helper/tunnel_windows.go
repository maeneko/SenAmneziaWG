package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/amnezia-vpn/amneziawg-windows/v3/services"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"

	"amnesiawg-helper/internal/proto"
)

const (
	startTimeout = 40 * time.Second // the first connect installs the Wintun driver
	stopTimeout  = 20 * time.Second
	poll         = 200 * time.Millisecond
)

// controller runs the one tunnel: it writes the .conf, registers the tunnel service with the SCM (the
// service is `awg-helper.exe tunnel <conf>`, which the fork's tunnel package runs), and undoes all of
// it. Addresses, routes, DNS and the firewall belong to that service and vanish when it stops.
type controller struct {
	d      dirs
	exe    string
	mirror *logMirror
	mu     sync.Mutex // one privileged operation at a time
}

func tunnelService() string {
	name, err := services.ServiceNameOfTunnel(tunnelName)
	if err != nil {
		panic(err) // tunnelName is a constant that satisfies the fork's own rule
	}
	return name
}

func svcErr(what string, err error) *proto.Error {
	return proto.Errf(proto.CodeService, fmt.Sprintf("Не удалось %s службу туннеля: %v", what, err))
}

// state reports whether the tunnel service is registered and what it is doing.
func (c *controller) state() (registered bool, st svc.State, err error) {
	m, err := mgr.Connect()
	if err != nil {
		return false, 0, err
	}
	defer m.Disconnect()
	s, err := m.OpenService(tunnelService())
	if err != nil {
		if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
			return false, 0, nil
		}
		return false, 0, err
	}
	defer s.Close()
	status, err := s.Query()
	return true, status.State, err
}

func active(st svc.State) bool { return st == svc.Running || st == svc.StartPending }

func (c *controller) up(req *proto.Request) (*proto.Response, error) {
	if perr := proto.ValidateUp(req); perr != nil {
		return nil, perr
	}
	c.mu.Lock()
	defer c.mu.Unlock()

	if _, err := os.Stat(filepath.Join(filepath.Dir(c.exe), "wintun.dll")); err != nil {
		return nil, proto.Errf(proto.CodeService, "В установке нет wintun.dll — переустановите AmnesiaWG")
	}
	registered, st, err := c.state()
	if err != nil {
		return nil, svcErr("проверить", err)
	}
	if registered {
		if active(st) && !req.Replace {
			return nil, proto.Errf(proto.CodeBusy, "Туннель уже активен")
		}
		// Switching servers, or clearing what a crashed tunnel left behind.
		c.teardownLocked()
	}
	if err := c.d.ensure(); err != nil {
		return nil, proto.Errf(proto.CodeInternal, "Не удалось подготовить каталог службы: "+err.Error())
	}

	c.mirror.Reset()
	c.mirror.Note(fmt.Sprintf("запускаю туннель «%s»", proto.SafeName(req.Name)))
	_ = os.Remove(c.d.confPath())
	// The directory's ACL (SYSTEM and Administrators only, inherited) is what protects the key.
	if err := os.WriteFile(c.d.confPath(), []byte(req.Conf), 0o600); err != nil {
		return nil, proto.Errf(proto.CodeInternal, "Не удалось записать конфигурацию: "+err.Error())
	}

	startedAt := time.Now()
	if perr := c.startLocked(); perr != nil {
		c.teardownLocked()
		return nil, perr
	}
	_ = c.d.saveState(state{ID: req.ID, Name: proto.SafeName(req.Name), StartedAt: startedAt.UnixMilli()})

	resp := &proto.Response{OK: true, Iface: tunnelName, StartedAt: startedAt.UnixMilli()}
	if text, err := uapiRequest("get=1\n\n", 3*time.Second); err == nil {
		resp.EndpointIP = endpointOf(text)
	}
	return resp, nil
}

// startLocked registers and starts the tunnel service and waits until it reports RUNNING.
func (c *controller) startLocked() *proto.Error {
	m, err := mgr.Connect()
	if err != nil {
		return svcErr("открыть менеджер", err)
	}
	defer m.Disconnect()

	cfg := mgr.Config{
		ServiceType:  windows.SERVICE_WIN32_OWN_PROCESS,
		StartType:    mgr.StartManual, // never comes back by itself after a reboot
		ErrorControl: mgr.ErrorNormal,
		Dependencies: []string{"Nsi", "TcpIp"},
		DisplayName:  "AmnesiaWG tunnel",
		SidType:      windows.SERVICE_SID_TYPE_UNRESTRICTED,
	}
	var s *mgr.Service
	// A service deleted a moment ago stays "marked for deletion" until every handle to it is closed.
	for i := 0; i < 25; i++ {
		s, err = m.CreateService(tunnelService(), c.exe, cfg, "tunnel", c.d.confPath())
		if err == nil || !(errors.Is(err, windows.ERROR_SERVICE_MARKED_FOR_DELETE) || errors.Is(err, windows.ERROR_SERVICE_EXISTS)) {
			break
		}
		time.Sleep(poll)
	}
	if err != nil {
		return svcErr("создать", err)
	}
	defer s.Close()
	if err := s.Start(); err != nil {
		return svcErr("запустить", err)
	}

	deadline := time.Now().Add(startTimeout)
	for time.Now().Before(deadline) {
		status, err := s.Query()
		if err != nil {
			return svcErr("опросить", err)
		}
		switch status.State {
		case svc.Running:
			return nil
		case svc.Stopped:
			return proto.Errf(proto.CodeService, "Туннель не запустился"+c.reason())
		}
		time.Sleep(poll)
	}
	return proto.Errf(proto.CodeService, "Туннель не запустился за отведённое время"+c.reason())
}

// reason is the tail of the tunnel's own log: a bad config or a missing driver is explained there.
func (c *controller) reason() string {
	tail := c.mirror.Tail(3)
	if len(tail) == 0 {
		return ""
	}
	return ": " + strings.Join(tail, " | ")
}

func (c *controller) down() (*proto.Response, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.mirror.Note("останавливаю туннель")
	c.teardownLocked()
	return &proto.Response{OK: true}, nil
}

// teardownLocked is best effort at every step, so it always runs to the end (like awg.sh's teardown).
func (c *controller) teardownLocked() (removed []string) {
	if m, err := mgr.Connect(); err == nil {
		defer m.Disconnect()
		if s, err := m.OpenService(tunnelService()); err == nil {
			if status, err := s.Query(); err == nil && status.State != svc.Stopped {
				_, _ = s.Control(svc.Stop)
				for deadline := time.Now().Add(stopTimeout); time.Now().Before(deadline); time.Sleep(poll) {
					if status, err := s.Query(); err != nil || status.State == svc.Stopped {
						break
					}
				}
			}
			_ = s.Delete()
			s.Close()
			removed = append(removed, "служба туннеля")
		}
	}
	if exists(c.d.confPath()) {
		_ = os.Remove(c.d.confPath())
		removed = append(removed, "конфигурация")
	}
	c.d.clearState()
	c.mirror.Drain()
	return removed
}

func (c *controller) status() (*proto.Response, error) {
	registered, st, err := c.state()
	if err != nil {
		return nil, svcErr("проверить", err)
	}
	resp := &proto.Response{OK: true}
	if registered && active(st) {
		s := c.d.loadState()
		resp.Active = &proto.Active{ID: s.ID, Iface: tunnelName, StartedAt: s.StartedAt}
	}
	resp.Stale = !(registered && active(st)) && (registered || exists(c.d.confPath()))
	return resp, nil
}

func (c *controller) stats() (*proto.Response, error) {
	registered, st, err := c.state()
	if err != nil {
		return nil, svcErr("проверить", err)
	}
	if !registered || st != svc.Running {
		return nil, proto.Errf(proto.CodeTunnelDead, "Туннель остановился неожиданно")
	}
	text, err := uapiRequest("get=1\n\n", 3*time.Second)
	if err != nil {
		return nil, proto.Errf(proto.CodeUAPI, "Нет ответа от туннеля: "+err.Error())
	}
	return &proto.Response{OK: true, UAPI: withoutSecrets(text)}, nil
}

func (c *controller) cleanup() (*proto.Response, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	removed := c.teardownLocked()
	if len(removed) > 0 {
		c.mirror.Note("очищено: " + strings.Join(removed, ", "))
	}
	return &proto.Response{OK: true}, nil
}

// reconcile runs when the helper starts. After a reboot or a crash a registered tunnel service may be
// left behind; nothing is worth keeping then (the adapter, routes and firewall rules died with the
// process), so it is removed quietly. A tunnel that is still running is adopted as it is.
func (c *controller) reconcile() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if registered, st, err := c.state(); err == nil && registered && !active(st) {
		c.teardownLocked()
	}
}
