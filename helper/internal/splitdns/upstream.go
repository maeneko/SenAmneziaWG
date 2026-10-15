package splitdns

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"time"
)

// Exchanger sends one DNS message and returns the answer.
type Exchanger interface {
	Exchange(ctx context.Context, query []byte, overTCP bool) ([]byte, error)
}

// Dialer opens a connection; the platform's own binds it to a network (the tunnel's, or the physical one).
type Dialer func(ctx context.Context, network, addr string) (net.Conn, error)

// Upstream asks a list of resolvers in turn.
type Upstream struct {
	Servers []netip.Addr
	Dial    Dialer
	Timeout time.Duration // per server; 3 s when zero
}

func (u *Upstream) timeout() time.Duration {
	if u.Timeout > 0 {
		return u.Timeout
	}
	return 3 * time.Second
}

// Exchange tries each server until one answers. UDP first; a truncated answer (or a client that came
// over TCP itself) is repeated over TCP.
func (u *Upstream) Exchange(ctx context.Context, query []byte, overTCP bool) ([]byte, error) {
	if len(query) < 12 {
		return nil, errors.New("короткий запрос")
	}
	var last error
	for _, s := range u.Servers {
		addr := net.JoinHostPort(s.String(), "53")
		var resp []byte
		var err error
		if !overTCP {
			resp, err = u.once(ctx, "udp", addr, query)
			if err == nil && len(resp) >= 3 && resp[2]&0x02 != 0 { // TC: the answer did not fit
				resp, err = u.once(ctx, "tcp", addr, query)
			}
		} else {
			resp, err = u.once(ctx, "tcp", addr, query)
		}
		if err == nil {
			return resp, nil
		}
		last = err
		if ctx.Err() != nil {
			break
		}
	}
	if last == nil {
		last = errors.New("нет DNS-серверов")
	}
	return nil, last
}

func (u *Upstream) once(ctx context.Context, network, addr string, query []byte) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, u.timeout())
	defer cancel()
	conn, err := u.Dial(ctx, network, addr)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	if dl, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(dl)
	}
	if network == "tcp" {
		msg := binary.BigEndian.AppendUint16(nil, uint16(len(query)))
		if _, err := conn.Write(append(msg, query...)); err != nil {
			return nil, err
		}
		var n [2]byte
		if _, err := io.ReadFull(conn, n[:]); err != nil {
			return nil, err
		}
		buf := make([]byte, binary.BigEndian.Uint16(n[:]))
		if _, err := io.ReadFull(conn, buf); err != nil {
			return nil, err
		}
		return checkID(query, buf)
	}
	if _, err := conn.Write(query); err != nil {
		return nil, err
	}
	buf := make([]byte, 4096)
	for {
		n, err := conn.Read(buf)
		if err != nil {
			return nil, err
		}
		// A stray datagram with another id is not ours: keep waiting until the deadline.
		if resp, err := checkID(query, buf[:n]); err == nil {
			return append([]byte(nil), resp...), nil
		}
	}
}

func checkID(query, resp []byte) ([]byte, error) {
	if len(resp) < 12 || resp[0] != query[0] || resp[1] != query[1] {
		return nil, fmt.Errorf("ответ с другим номером")
	}
	return resp, nil
}
