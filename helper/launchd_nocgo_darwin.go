//go:build darwin && !cgo

package main

import (
	"errors"
	"net"
)

// launchdListener needs launch_activate_socket (cgo). This stub only keeps `CGO_ENABLED=0 go vet` and
// cross-builds compiling; scripts/build-helper-mac.mjs always builds with cgo.
func launchdListener(string) (net.Listener, error) {
	return nil, errors.New("awg-helper собран без cgo и не может получить сокет от launchd")
}
