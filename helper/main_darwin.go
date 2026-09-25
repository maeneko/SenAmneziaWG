// awg-helper on macOS is the SenAWG service: installed once (with the one admin prompt it takes), then
// started by launchd whenever the app connects to its socket, so connecting and disconnecting need no
// password. The tunnel itself is still set up by awg.sh, as root, exactly as the admin prompt used to
// run it; the service only checks each request and supplies what must not come from the app.
//
//	awg-helper service                     what launchd runs; by hand only while developing (listenSocket)
//	awg-helper install --from <Resources>  copies the service out of the app, hands it to launchd (root)
//	awg-helper uninstall                   the reverse, the tunnel included (root)
//	awg-helper version
package main

import (
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"senawg-helper/internal/lifetime"
)

const usage = "usage: awg-helper service | install --from <Contents/Resources> | uninstall | version"

// idleTimeout: launchd starts the service for a connection, so an app is normally known at once; this
// is only for a start nobody follows up.
const idleTimeout = 60 * time.Second

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	}
	switch os.Args[1] {
	case "service":
		os.Exit(runService())
	case "install":
		os.Exit(runInstall(os.Args[2:]))
	case "uninstall":
		os.Exit(runUninstall(os.Args[2:]))
	case "version":
		fmt.Printf("awg-helper %s (amneziawg-go %s)\n", version, awgGoVersion())
	default:
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	}
}

// runService serves until the app it serves is gone, then exits; launchd starts it again on the next
// connection. Exiting leaves a running tunnel alone: it belongs to awg.sh's daemon and monitor, which
// run in their own session (tunnel_darwin.go) and take the tunnel down with the app themselves.
func runService() int {
	l, owned, err := listenSocket()
	if err != nil {
		fmt.Fprintln(os.Stderr, "service:", err)
		return 1
	}
	life := lifetime.New(awaitExit)
	c := newController(life)
	if c.installErr != nil {
		svcError("%v", c.installErr)
	}
	go serve(c, l)
	life.Idle(idleTimeout)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	select {
	case <-sig:
	case <-life.Done():
	}
	life.Close()
	l.Close()
	if owned {
		_ = os.Remove(socketPath)
	}
	return 0
}
