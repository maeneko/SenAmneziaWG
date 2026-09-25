// Package proto is the wire protocol between the SenAWG app and the helper service: one JSON
// object per line, one request and one response per connection. It imports nothing Windows-specific,
// so it is built and tested on every platform.
package proto

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
)

// Version is bumped when a request or response changes shape; the app refuses a helper that differs.
const Version = 1

// MaxLine bounds one request: the biggest legitimate payload is a .conf (MaxConf) plus JSON framing.
const MaxLine = 64 * 1024

const (
	OpHello   = "hello"
	OpUp      = "up"
	OpDown    = "down"
	OpStatus  = "status"
	OpStats   = "stats"
	OpNetinfo = "netinfo"
	OpCleanup = "cleanup"

	// Linux only: the service keeps the tunnel keys itself when the desktop has no keyring (see
	// internal/vault). They go in once, at import, and never come back out: `up` with Vault set has the
	// service put them into the UAPI body on its own side.
	OpSecretPut    = "secret-put"
	OpSecretDelete = "secret-delete"

	// Linux only: signs a request of the sen:// subscription protocol (/sub/v1) with the Ed25519 auth key
	// that secret-put stored under a "sen-" id, so that key too never leaves the service.
	OpSenSign = "sen-sign"
)

// Error codes. The text is shown to the user as is, so it is written for them.
const (
	CodeBadRequest  = "BAD_REQUEST"
	CodeBusy        = "BUSY"
	CodeConfInvalid = "CONF_INVALID"
	CodeService     = "SERVICE"
	CodeTunnelDead  = "TUNNEL_DEAD"
	CodeNoTunnel    = "NO_TUNNEL"
	CodeUAPI        = "UAPI"
	CodeInternal    = "INTERNAL"
	CodeNoSecret    = "NO_SECRET"
	// macOS: the service answers only the user at the screen (socket_darwin.go).
	CodeNoAccess = "NO_ACCESS"
)

type Request struct {
	V       int    `json:"v"`
	Op      string `json:"op"`
	ID      string `json:"id,omitempty"`
	Name    string `json:"name,omitempty"`
	Conf    string `json:"conf,omitempty"`
	Replace bool   `json:"replace,omitempty"`
	Target  string `json:"target,omitempty"`
	// The app's own process id. The tunnel is stopped when that process goes away, so every request
	// carries it: `up` arms the watcher, `status` re-points it at an app that restarted.
	PID uint32 `json:"pid,omitempty"`

	// Linux only (tunnel_linux.go): Conf here is the UAPI `set=1` body (ValidateUpUAPI), the same one
	// macOS sends to awg.sh; Address, Mtu and Dns are what awg.sh instead takes as --address/--mtu/--dns
	// CLI flags, since there is no shell script here to hand them to. AllowedIPs is read back out of
	// Conf's own `allowed_ip=` lines (allowedIPsOf in uapitext.go) rather than repeated here.
	Address []string `json:"address,omitempty"`
	Mtu     int      `json:"mtu,omitempty"`
	Dns     []string `json:"dns,omitempty"`

	// macOS only, up: awg.sh's --diagnostics (packet capture and a network snapshot, Logs →
	// «Диагностика подключения»).
	Diagnostics bool `json:"diagnostics,omitempty"`

	// Linux only. secret-put: the keys, in base64 as in a .conf. up: Vault means Conf comes without
	// private_key/preshared_key and the service adds the ones it keeps for ID (InjectSecrets).
	PrivateKey   string `json:"privateKey,omitempty"`
	PresharedKey string `json:"presharedKey,omitempty"`
	Vault        bool   `json:"vault,omitempty"`

	// Linux only, sen-sign: the request string to sign (ValidateSenSign says what it may look like).
	Message string `json:"message,omitempty"`

	// Who is asking, as the kernel says (SO_PEERCRED), never as the request says: not decoded from
	// JSON. Keys are kept per user, so one local user cannot use or overwrite another's.
	UID      uint32 `json:"-"`
	UIDKnown bool   `json:"-"`
}

type Active struct {
	ID        string `json:"id"`
	Iface     string `json:"iface"`
	StartedAt int64  `json:"startedAt"`
}

type Resolver struct {
	Iface       string   `json:"iface"`
	Nameservers []string `json:"nameservers"`
}

// Response is one struct for every verb; each fills only its own fields.
type Response struct {
	OK    bool   `json:"ok"`
	Code  string `json:"code,omitempty"`
	Error string `json:"error,omitempty"`

	// hello
	Protocol int    `json:"protocol,omitempty"`
	Helper   string `json:"helper,omitempty"`
	AwgGo    string `json:"awgGo,omitempty"`
	// macOS: which build of the service's files is installed (macinstall.go: buildID); the app
	// reinstalls the service when its own Resources hash differently.
	Build string `json:"build,omitempty"`

	// up
	Iface      string `json:"iface,omitempty"`
	StartedAt  int64  `json:"startedAt,omitempty"`
	EndpointIP string `json:"endpointIp,omitempty"`

	// status
	Active *Active `json:"active,omitempty"`
	Stale  bool    `json:"stale,omitempty"`

	// sen-sign: Ed25519 signature, base64url without padding
	Sig string `json:"sig,omitempty"`

	// stats: the daemon's `get=1` answer, without key material
	UAPI string `json:"uapi,omitempty"`

	// netinfo
	RouteIface string    `json:"routeIface,omitempty"`
	Resolver   *Resolver `json:"resolver,omitempty"`
}

// Error is a failure the app can show: a stable code and a message for the user.
type Error struct {
	Code string
	Msg  string
}

func (e *Error) Error() string { return e.Msg }

func Errf(code, msg string) *Error { return &Error{Code: code, Msg: msg} }

// Fail turns any error into a response; anything that is not an *Error is reported as internal.
func Fail(err error) *Response {
	var pe *Error
	if errors.As(err, &pe) {
		return &Response{Code: pe.Code, Error: pe.Msg}
	}
	return &Response{Code: CodeInternal, Error: "Внутренняя ошибка службы SenAWG: " + err.Error()}
}

var errLineTooLong = errors.New("request line too long")

// ReadRequest reads one line and decodes it. It never buffers more than MaxLine bytes.
func ReadRequest(r *bufio.Reader) (*Request, error) {
	var line []byte
	for {
		chunk, err := r.ReadSlice('\n')
		line = append(line, chunk...)
		if len(line) > MaxLine {
			return nil, errLineTooLong
		}
		if err == nil {
			break
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if errors.Is(err, io.EOF) && len(bytes.TrimSpace(line)) > 0 {
			break
		}
		return nil, err
	}
	var req Request
	if err := json.Unmarshal(bytes.TrimSpace(line), &req); err != nil {
		return nil, errors.New("malformed request")
	}
	return &req, nil
}

// WriteResponse writes one line.
func WriteResponse(w io.Writer, resp *Response) error {
	b, err := json.Marshal(resp)
	if err != nil {
		return err
	}
	_, err = w.Write(append(b, '\n'))
	return err
}
