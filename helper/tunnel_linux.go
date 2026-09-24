//go:build linux

package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"senawg-helper/internal/lifetime"
	"senawg-helper/internal/proto"
	"senawg-helper/internal/vault"
)

const (
	startTimeout = 10 * time.Second // how long the daemon gets to open its UAPI socket
	stopTimeout  = 3 * time.Second  // SIGTERM before SIGKILL, same margin as awg.sh's teardown
)

// controller runs the one tunnel: it spawns the bundled amneziawg-go on a fixed interface (senawg0),
// programs it over its own UAPI socket, and does the routing, DNS and process bookkeeping awg.sh does
// on macOS — here in Go instead of a root shell script, and reached over a Unix socket instead of an
// osascript prompt (there is no per-connection prompt: the service itself was installed with one, by
// `setup`, per the plan's "служба, как на Windows" decision).
type controller struct {
	d     dirs
	life  *lifetime.Lifetime
	vault *vault.Vault

	mu        sync.Mutex // one privileged operation at a time, like awg.sh's single state file
	daemonPID int        // 0 when no tunnel is running
	logf      *os.File
	routes    routeState
	dns       dnsState
	id, name  string
	startedAt time.Time
}

func newController(d dirs, life *lifetime.Lifetime) *controller {
	return &controller{d: d, life: life, vault: vault.New(d.secretsDir())}
}

// watch satisfies the engine interface (dispatch.go).
func (c *controller) watch(pid uint32) { c.life.Watch(pid) }

// binaryPath is the bundled amneziawg-go: always next to awg-helper itself when installed (`setup`
// copies both into the same directory), like Windows keeps wintun.dll next to awg-helper.exe. In
// development it also accepts one on PATH.
func binaryPath() (string, error) {
	if exe, err := os.Executable(); err == nil {
		candidate := filepath.Join(filepath.Dir(exe), "amneziawg-go")
		if st, err := os.Stat(candidate); err == nil && !st.IsDir() {
			return candidate, nil
		}
	}
	if p, err := exec.LookPath("amneziawg-go"); err == nil {
		return p, nil
	}
	return "", fmt.Errorf("в установке нет amneziawg-go")
}

func (c *controller) up(req *proto.Request) (*proto.Response, error) {
	if req.Vault {
		if err := c.withKeptKeys(req); err != nil {
			return nil, err
		}
	}
	if perr := proto.ValidateUpUAPI(req); perr != nil {
		return nil, perr
	}
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.daemonPID != 0 {
		if !req.Replace && processAlive(uint32(c.daemonPID)) {
			return nil, proto.Errf(proto.CodeBusy, "Туннель уже активен")
		}
		c.teardownLocked()
	}

	bin, err := binaryPath()
	if err != nil {
		return nil, proto.Errf(proto.CodeService, err.Error())
	}
	if err := os.MkdirAll(c.d.lib, 0o700); err != nil {
		return nil, proto.Errf(proto.CodeInternal, "Не удалось подготовить каталог службы: "+err.Error())
	}
	if err := os.MkdirAll(c.d.run, 0o755); err != nil {
		return nil, proto.Errf(proto.CodeInternal, "Не удалось подготовить каталог службы: "+err.Error())
	}

	logf, err := os.OpenFile(c.d.daemonLog(), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, proto.Errf(proto.CodeInternal, "Не удалось открыть журнал: "+err.Error())
	}

	cmd := exec.Command(bin, "-f", tunnelName)
	cmd.Env = append(os.Environ(), "LOG_LEVEL=debug")
	cmd.Stdout, cmd.Stderr = logf, logf
	// Setsid: detaches from whatever session started this service (pkexec, a terminal), so the tunnel
	// is never killed by a signal meant for that session. It still dies with this process's own exit
	// unless that exit is a clean one (down/cleanup kill it first) — see the package comment in
	// route_linux.go's neighbour, dns_linux.go, for what "clean" undoes.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		logf.Close()
		return nil, proto.Errf(proto.CodeService, "Не удалось запустить amneziawg-go: "+err.Error())
	}
	pid := cmd.Process.Pid
	// Reap it ourselves when it exits, whenever that is: nothing else is this process's parent.
	go func() { _ = cmd.Wait() }()

	if err := waitSocket(tunnelName, startTimeout); err != nil {
		_ = terminate(pid)
		logf.Close()
		return nil, proto.Errf(proto.CodeService, "Туннель не запустился за отведённое время")
	}

	body := withFwmark(req.Conf, fwmarkTable)
	if _, err := uapiRequest(tunnelName, body, 3*time.Second); err != nil {
		_ = terminate(pid)
		logf.Close()
		return nil, proto.Errf(proto.CodeConfInvalid, "Демон отклонил конфигурацию: "+err.Error())
	}

	if err := configureLink(tunnelName, req.Address, req.Mtu); err != nil {
		_ = terminate(pid)
		logf.Close()
		return nil, proto.Errf(proto.CodeService, err.Error())
	}
	routes, err := applyRoutes(tunnelName, allowedIPsOf(req.Conf))
	if err != nil {
		removeRoutes(routes)
		_ = terminate(pid)
		logf.Close()
		return nil, proto.Errf(proto.CodeService, err.Error())
	}
	dnsSt := setDNS(c.d, tunnelName, req.Dns)

	startedAt := time.Now()
	c.daemonPID, c.logf, c.routes, c.dns = pid, logf, routes, dnsSt
	c.id, c.name, c.startedAt = req.ID, proto.SafeName(req.Name), startedAt
	_ = c.d.saveState(state{
		ID: req.ID, Name: c.name, StartedAt: startedAt.UnixMilli(), PID: req.PID, DaemonPID: pid,
		Routes: routes, DNS: dnsSt,
	})

	resp := &proto.Response{OK: true, Iface: tunnelName, StartedAt: startedAt.UnixMilli()}
	if text, err := uapiRequest(tunnelName, "get=1\n\n", 2*time.Second); err == nil {
		resp.EndpointIP = endpointOf(text)
	}
	return resp, nil
}

// withKeptKeys completes an `up` whose keys the service keeps (see internal/vault): the app sent the
// body without them, and they are added here, for the user on the other end of the socket only.
func (c *controller) withKeptKeys(req *proto.Request) error {
	if perr := proto.ValidateSecretID(req); perr != nil {
		return perr
	}
	if !req.UIDKnown {
		return proto.Errf(proto.CodeBadRequest, "Не удалось определить пользователя")
	}
	k, err := c.vault.Get(req.UID, req.ID)
	if errors.Is(err, vault.ErrNotFound) {
		return proto.Errf(proto.CodeNoSecret, "Ключи туннеля не найдены в службе SenAWG — импортируйте ссылку заново")
	}
	if err != nil {
		return proto.Errf(proto.CodeInternal, "Не удалось прочитать ключи туннеля: "+err.Error())
	}
	conf, err := proto.InjectSecrets(req.Conf, k.PrivateKey, k.PresharedKey)
	if err != nil {
		return proto.Errf(proto.CodeConfInvalid, "Конфигурация туннеля отклонена: "+err.Error())
	}
	req.Conf = conf
	return nil
}

// secretPut and secretDelete make controller a keyStore (dispatch.go). They do not take c.mu: the
// vault's files are independent of the running tunnel, and each write is a single rename.
func (c *controller) secretPut(req *proto.Request) (*proto.Response, error) {
	if perr := proto.ValidateSecretPut(req); perr != nil {
		return nil, perr
	}
	if !req.UIDKnown {
		return nil, proto.Errf(proto.CodeBadRequest, "Не удалось определить пользователя")
	}
	k := vault.Keys{PrivateKey: req.PrivateKey, PresharedKey: req.PresharedKey}
	if err := c.vault.Put(req.UID, req.ID, k); err != nil {
		return nil, proto.Errf(proto.CodeInternal, "Не удалось сохранить ключи: "+err.Error())
	}
	return &proto.Response{OK: true}, nil
}

func (c *controller) secretDelete(req *proto.Request) (*proto.Response, error) {
	if perr := proto.ValidateSecretID(req); perr != nil {
		return nil, perr
	}
	if !req.UIDKnown {
		return nil, proto.Errf(proto.CodeBadRequest, "Не удалось определить пользователя")
	}
	if err := c.vault.Delete(req.UID, req.ID); err != nil {
		return nil, proto.Errf(proto.CodeInternal, "Не удалось удалить ключи: "+err.Error())
	}
	return &proto.Response{OK: true}, nil
}

func (c *controller) down() (*proto.Response, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.teardownLocked()
	return &proto.Response{OK: true}, nil
}

// teardownLocked is best effort at every step, so it always runs to the end (like awg.sh's teardown
// and tunnel_windows.go's teardownLocked).
func (c *controller) teardownLocked() {
	if c.daemonPID != 0 {
		_ = terminate(c.daemonPID)
	}
	removeRoutes(c.routes)
	restoreDNS(c.d, c.dns)
	if c.logf != nil {
		c.logf.Close()
	}
	c.daemonPID, c.logf, c.routes, c.dns, c.id, c.name = 0, nil, routeState{}, dnsState{}, "", ""
	c.d.clearState()
}

func (c *controller) status() (*proto.Response, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	resp := &proto.Response{OK: true}
	alive := c.daemonPID != 0 && processAlive(uint32(c.daemonPID))
	if alive {
		resp.Active = &proto.Active{ID: c.id, Iface: tunnelName, StartedAt: c.startedAt.UnixMilli()}
	} else if c.daemonPID != 0 {
		// It died on its own; nothing here calls that discovery out loud, same as tunnel_windows.go's
		// status(), which also only reports Stale and lets the next `up` or `cleanup` clear it.
		resp.Stale = true
	}
	return resp, nil
}

func (c *controller) stats() (*proto.Response, error) {
	c.mu.Lock()
	pid := c.daemonPID
	c.mu.Unlock()
	if pid == 0 || !processAlive(uint32(pid)) {
		return nil, proto.Errf(proto.CodeTunnelDead, "Туннель остановился неожиданно")
	}
	text, err := uapiRequest(tunnelName, "get=1\n\n", 3*time.Second)
	if err != nil {
		return nil, proto.Errf(proto.CodeUAPI, "Нет ответа от туннеля: "+err.Error())
	}
	return &proto.Response{OK: true, UAPI: withoutSecrets(text)}, nil
}

func (c *controller) cleanup() (*proto.Response, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.teardownLocked()
	return &proto.Response{OK: true}, nil
}

// reconcile runs once, when the helper starts. Unlike the Windows tunnel service, amneziawg-go here is
// a child of this same process: it cannot survive this process being killed outright (SIGKILL), only a
// clean exit, which always tears it down first. So there is nothing to reattach to — reconcile's job is
// only to undo whatever routing and DNS changes a state file left behind (a crash, or a kill -9), the
// same leftovers awg.sh's own state file exists to let a later `down` clean up.
func (c *controller) reconcile() {
	c.mu.Lock()
	defer c.mu.Unlock()
	s := c.d.loadState()
	if s.DaemonPID == 0 {
		return
	}
	if processAlive(uint32(s.DaemonPID)) {
		_ = terminate(s.DaemonPID)
	}
	removeRoutes(s.Routes)
	restoreDNS(c.d, s.DNS)
	c.d.clearState()
}

// waitSocket polls for the daemon's UAPI socket to appear, the Go equivalent of awg.sh's own wait loop
// for the same thing before it hands the socket to the caller.
func waitSocket(iface string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		if _, err := os.Stat(daemonSocket(iface)); err == nil {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("сокет не появился")
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// terminate asks pid to stop, then insists. It works whether or not pid is still our own child (see
// reconcile): syscall.Kill only needs the number.
func terminate(pid int) error {
	if !processAlive(uint32(pid)) {
		return nil
	}
	_ = syscall.Kill(pid, syscall.SIGTERM)
	deadline := time.Now().Add(stopTimeout)
	for time.Now().Before(deadline) {
		if !processAlive(uint32(pid)) {
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	return syscall.Kill(pid, syscall.SIGKILL)
}
