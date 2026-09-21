// awg-helper is the Windows side of AmnesiaWG. One executable, four jobs:
//
//	awg-helper service           the LocalSystem service (started by the SCM): the app's pipe
//	awg-helper tunnel <conf>     the tunnel service (started by the SCM): the fork's tunnel package
//	awg-helper install [--dev]|uninstall  register or remove the service (development, and `setup` uses the same code)
//	awg-helper setup --app-from D --app-to D   run by the app when the user presses «Установить», elevated
//	awg-helper remove [--progress F]  the UninstallString in «Программы и компоненты», or the app's own «Удалить»
//	awg-helper version
package main

import (
	"fmt"
	"os"
	"runtime/debug"

	"amnesiawg-helper/internal/setup"
	"github.com/amnezia-vpn/amneziawg-windows/v3/conf"
	"github.com/amnezia-vpn/amneziawg-windows/v3/tunnel"
	"golang.org/x/sys/windows/svc"
)

// Set at build time: -ldflags "-X main.version=...".
var version = "dev"

const usage = "usage: awg-helper service | tunnel <conf> | install [--dev] | uninstall | " + setup.Usage + " | " + setup.RemoveUsage + " | version"

func depVersion(path string) string {
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, dep := range info.Deps {
			if dep.Path == path {
				if dep.Replace != nil {
					return dep.Replace.Version
				}
				return dep.Version
			}
		}
	}
	return "unknown"
}

// awgGoVersion is the daemon compiled into this executable, e.g. "v3.1.20260828". The app compares it
// with what a config needs, as it does with the daemon it runs on macOS.
func awgGoVersion() string { return depVersion("github.com/amnezia-vpn/amneziawg-go/v3") }

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	}
	switch os.Args[1] {
	case "service":
		if err := svc.Run(managerServiceName, managerService{}); err != nil {
			// Typically: started from a console instead of by the service manager.
			fmt.Fprintln(os.Stderr, "service:", err)
			os.Exit(1)
		}
	case "tunnel":
		if len(os.Args) != 3 {
			fmt.Fprintln(os.Stderr, usage)
			os.Exit(2)
		}
		d, err := layout()
		if err != nil {
			os.Exit(1)
		}
		conf.PresetRootDirectory(d.data)
		// One adapter identity for every server, so Windows keeps a single network profile for it
		// instead of a new one per configuration.
		tunnel.UseFixedGUIDInsteadOfDeterministic = true
		if err := tunnel.Run(os.Args[2]); err != nil {
			os.Exit(1)
		}
	case "install":
		// --dev: allow running from outside Program Files (a checkout), knowing what that means.
		if err := installManager(len(os.Args) > 2 && os.Args[2] == "--dev"); err != nil {
			fmt.Fprintln(os.Stderr, "install:", err)
			os.Exit(1)
		}
	case "uninstall":
		if err := uninstallManager(); err != nil {
			fmt.Fprintln(os.Stderr, "uninstall:", err)
			os.Exit(1)
		}
	case "setup":
		os.Exit(runSetup(os.Args[2:]))
	case "remove":
		os.Exit(runRemove(os.Args[2:]))
	case "version":
		fmt.Printf("awg-helper %s (amneziawg-go %s, amneziawg-windows %s)\n", version, awgGoVersion(),
			depVersion("github.com/amnezia-vpn/amneziawg-windows/v3"))
	default:
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	}
}
