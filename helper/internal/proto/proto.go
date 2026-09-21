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

	// up
	Iface      string `json:"iface,omitempty"`
	StartedAt  int64  `json:"startedAt,omitempty"`
	EndpointIP string `json:"endpointIp,omitempty"`

	// status
	Active *Active `json:"active,omitempty"`
	Stale  bool    `json:"stale,omitempty"`

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
