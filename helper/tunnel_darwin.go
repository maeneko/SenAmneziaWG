//go:build darwin

package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"senawg-helper/internal/lifetime"
	"senawg-helper/internal/proto"
)

const (
	// awg.sh's own waits add up to about 10 s (the interface) plus a few for routes and DNS; past this
	// something is stuck, and the script is killed rather than left holding the service.
	scriptTimeout = 60 * time.Second
	statusTimeout = 1500 * time.Millisecond
)

// controller is the macOS engine (dispatch.go): every privileged step is awg.sh's, run as root from the
// service's own directory. What the admin prompt used to vouch for — which daemon to run, for whom, tied
// to which app — the service now decides itself (awgShUpArgs), so the socket can be open to the user.
type controller struct {
	mu   sync.Mutex // one awg.sh at a time: it keeps a single state file
	life *lifetime.Lifetime
	dir  string
	// Set when the service's files could be changed by someone other than root: then it refuses to run
	// any of them (checkInstall), and says so on every request that would.
	installErr error
}

func newController(life *lifetime.Lifetime) *controller {
	c := &controller{life: life}
	dir, err := installDir()
	if err == nil {
		c.dir = dir
		err = checkInstall(dir)
	}
	c.installErr = err
	return c
}

func (c *controller) script() string { return filepath.Join(c.dir, "awg.sh") }
func (c *controller) binary() string { return filepath.Join(c.dir, "amneziawg-go") }

// watch satisfies the engine interface (dispatch.go).
func (c *controller) watch(pid uint32) { c.life.Watch(pid) }

func init() {
	// Hashed once: the files cannot change under a running service without an install, which restarts it.
	serviceBuild = sync.OnceValue(func() string {
		dir, err := installDir()
		if err != nil {
			return ""
		}
		id, err := buildID(dir, false)
		if err != nil {
			return ""
		}
		return id
	})
	awgGoVersion = func() string {
		dir, err := installDir()
		if err != nil {
			return "unknown"
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		out, err := exec.CommandContext(ctx, filepath.Join(dir, "amneziawg-go"), "--version").Output()
		if err != nil {
			return "unknown"
		}
		return parseAwgGoVersion(string(out))
	}
}

// checkInstall: root runs these files, so nobody but root may be able to change them — not the file,
// and not any directory on the way to it, where a rename would swap the file for another.
func checkInstall(dir string) error {
	for d := dir; ; d = filepath.Dir(d) {
		if err := checkRootOnly(d); err != nil {
			return err
		}
		if d == "/" {
			break
		}
	}
	for _, name := range []string{"awg-helper", "awg.sh", "amneziawg-go"} {
		if err := checkRootOnly(filepath.Join(dir, name)); err != nil {
			return err
		}
	}
	return nil
}

func checkRootOnly(path string) error {
	fi, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("служба SenAWG установлена не полностью: %v", err)
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok || st.Uid != 0 || fi.Mode()&0o022 != 0 || fi.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("служба SenAWG установлена неправильно: %s может изменить не только администратор — переустановите SenAWG", path)
	}
	return nil
}

// runScript runs awg.sh as this (root) process. Setsid: the daemon and monitor awg.sh leaves running
// get a session of their own, so launchd does not kill them along with the service's process group
// when the service exits; the tunnel lives as long as the app does, not as long as the service.
func (c *controller) runScript(args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), scriptTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/bin/bash", append([]string{c.script()}, args...)...)
	cmd.Env = []string{"PATH=/usr/sbin:/usr/bin:/bin:/sbin", "LANG=en_US.UTF-8"}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	out, err := cmd.CombinedOutput()
	if ctx.Err() != nil {
		return string(out), errors.New("скрипт туннеля не завершился за отведённое время")
	}
	return string(out), err
}

// scriptResult logs awg.sh's warnings and turns a failure into an error for the user.
func scriptResult(out string, err error, fallback string) error {
	warnings, rest := splitScriptOutput(out)
	for _, w := range warnings {
		svcWarn("%s", w)
	}
	if err == nil {
		return nil
	}
	if rest == "" {
		rest = fallback + ": " + err.Error()
	}
	svcError("%s", rest)
	return proto.Errf(proto.CodeService, rest)
}

func (c *controller) up(req *proto.Request) (*proto.Response, error) {
	if c.installErr != nil {
		return nil, proto.Errf(proto.CodeService, c.installErr.Error())
	}
	if perr := proto.ValidateUpUAPI(req); perr != nil {
		return nil, perr
	}
	c.mu.Lock()
	defer c.mu.Unlock()

	if err := os.MkdirAll(stateDir, 0o755); err != nil {
		return nil, proto.Errf(proto.CodeInternal, "Не удалось подготовить каталог службы: "+err.Error())
	}
	// The key goes to awg.sh in a root-only file (argv is visible in ps); awg.sh deletes it after use.
	f, err := os.CreateTemp(stateDir, "body.*")
	if err != nil {
		return nil, proto.Errf(proto.CodeInternal, "Не удалось подготовить конфигурацию: "+err.Error())
	}
	body := f.Name()
	defer os.Remove(body)
	_, werr := f.WriteString(req.Conf)
	if cerr := f.Close(); werr == nil {
		werr = cerr
	}
	if werr != nil {
		return nil, proto.Errf(proto.CodeInternal, "Не удалось подготовить конфигурацию: "+werr.Error())
	}

	args, err := awgShUpArgs(req, c.binary(), body, processName(req.PID))
	if err != nil {
		return nil, proto.Errf(proto.CodeConfInvalid, err.Error())
	}
	out, err := c.runScript(args...)
	if err := scriptResult(out, err, "Не удалось поднять туннель"); err != nil {
		return nil, err
	}

	st, startedAt := readState()
	if st["IFACE"] == "" {
		return nil, proto.Errf(proto.CodeService, "Туннель запущен, но интерфейс не определён")
	}
	svcInfo("подключение «%s»: %s, amneziawg-go %s, адреса %v, MTU %d, DNS %v, allowed_ip %v, приложение pid %d",
		proto.SafeName(req.Name), st["IFACE"], awgGoVersion(), req.Address, req.Mtu, req.Dns, allowedIPsOf(req.Conf), req.PID)
	return &proto.Response{OK: true, Iface: st["IFACE"], StartedAt: startedAt, EndpointIP: endpointOf(req.Conf)}, nil
}

func (c *controller) down() (*proto.Response, error) {
	if c.installErr != nil {
		return nil, proto.Errf(proto.CodeService, c.installErr.Error())
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	out, err := c.runScript("down")
	if err := scriptResult(out, err, "Не удалось остановить туннель"); err != nil {
		return nil, err
	}
	return &proto.Response{OK: true}, nil
}

// cleanup is the same `awg.sh down`: it undoes whatever state.env records, running daemon or not.
func (c *controller) cleanup() (*proto.Response, error) { return c.down() }

// readState reads awg.sh's state.env, and when awg.sh wrote it: the last thing `up` does, so its mtime
// is the tunnel's start time (as macosScriptController.ts's recover() had it).
func readState() (map[string]string, int64) {
	b, err := os.ReadFile(stateFilePath())
	if err != nil {
		return nil, 0
	}
	var startedAt int64
	if fi, err := os.Stat(stateFilePath()); err == nil {
		startedAt = fi.ModTime().UnixMilli()
	}
	return parseStateEnv(string(b)), startedAt
}

// status: a tunnel runs when state.env names one and its daemon answers on UAPI; a state file with no
// answer behind it is a dead session whose DNS and routes may still be applied (Stale, cleanup's job).
func (c *controller) status() (*proto.Response, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	st, startedAt := readState()
	if st == nil {
		return &proto.Response{OK: true}, nil
	}
	if st["ID"] != "" && st["IFACE"] != "" {
		if _, err := uapiRequest(st["IFACE"], "get=1\n\n", statusTimeout); err == nil {
			return &proto.Response{OK: true, Active: &proto.Active{ID: st["ID"], Iface: st["IFACE"], StartedAt: startedAt}}, nil
		}
	}
	return &proto.Response{OK: true, Stale: true}, nil
}

func (c *controller) stats() (*proto.Response, error) {
	st, _ := readState()
	if st["IFACE"] == "" {
		return nil, proto.Errf(proto.CodeTunnelDead, "Туннель остановился неожиданно")
	}
	text, err := uapiRequest(st["IFACE"], "get=1\n\n", 3*time.Second)
	if err != nil {
		if strings.Contains(err.Error(), "no such file") {
			return nil, proto.Errf(proto.CodeTunnelDead, "Туннель остановился неожиданно")
		}
		return nil, proto.Errf(proto.CodeUAPI, "Нет ответа от туннеля: "+err.Error())
	}
	return &proto.Response{OK: true, UAPI: withoutSecrets(text)}, nil
}
