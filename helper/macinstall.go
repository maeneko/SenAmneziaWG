// macinstall.go is what `awg-helper install` (install_darwin.go) needs that can be tested without root
// or launchd: which files make up the service, how its copy is staged, its build id, its launchd plist.
// No build tag, so it is tested everywhere.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"senawg-helper/internal/setup"
)

const serviceLabel = "ru.senawg.helper"

// serviceFiles: each file of the installed service, and where it sits in the app's Contents/Resources
// (electron-builder.yml: mac.extraResources). The service runs all three as root from its own copy.
var serviceFiles = []struct{ name, source string }{
	{"awg-helper", "bin/awg-helper"},
	{"amneziawg-go", "bin/amneziawg-go"},
	{"awg.sh", "scripts/awg.sh"},
}

// stageService copies the service's files from the app's Resources into setup.NextDir(target), fresh
// (whatever an abandoned attempt left there goes first), for setup.Swap to put in place. Created by
// root in a root-owned directory, the copies are root's; 0755, so nobody else can change them.
func stageService(resources, target string) error {
	next := setup.NextDir(target)
	if err := os.RemoveAll(next); err != nil {
		return fmt.Errorf("не удалось убрать %s: %w", next, err)
	}
	if err := os.MkdirAll(next, 0o755); err != nil {
		return err
	}
	for _, f := range serviceFiles {
		if err := copyExecutable(filepath.Join(resources, f.source), filepath.Join(next, f.name)); err != nil {
			_ = os.RemoveAll(next)
			return fmt.Errorf("не удалось скопировать %s: %w", f.name, err)
		}
	}
	return nil
}

func copyExecutable(from, to string) error {
	in, err := os.Open(from)
	if err != nil {
		return err
	}
	defer in.Close()
	if fi, err := in.Stat(); err != nil {
		return err
	} else if !fi.Mode().IsRegular() {
		return errors.New("не обычный файл")
	}
	out, err := os.OpenFile(to, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Chmod(0o755); err != nil { // past the umask
		out.Close()
		return err
	}
	return out.Close()
}

// buildID identifies one build of the service: a SHA-256 over each file's own SHA-256, in serviceFiles
// order, as "<name>\x00<hex>\n" lines. The app computes the same over its Resources (stage 3) and
// reinstalls the service when the two differ, so a new awg.sh or daemon never waits for a new helper.
// dir holds the files under their installed names, or with fromResources, is the app's Resources.
func buildID(dir string, fromResources bool) (string, error) {
	total := sha256.New()
	for _, f := range serviceFiles {
		path := filepath.Join(dir, f.name)
		if fromResources {
			path = filepath.Join(dir, f.source)
		}
		sum, err := fileSHA256(path)
		if err != nil {
			return "", err
		}
		fmt.Fprintf(total, "%s\x00%s\n", f.name, sum)
	}
	return hex.EncodeToString(total.Sum(nil)), nil
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// servicePlist is the launchd job: started on demand by a connection to its socket (Sockets), never at
// boot or kept alive. AbandonProcessGroup, beside the Setsid awg.sh already runs with: nothing the
// service started may be killed with it, least of all the tunnel. AssociatedBundleIdentifiers lets
// System Settings → Login Items show it under SenAWG.
func servicePlist(program, socket, stderrLog string) string {
	esc := func(s string) string {
		return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(s)
	}
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>` + serviceLabel + `</string>
	<key>ProgramArguments</key>
	<array>
		<string>` + esc(program) + `</string>
		<string>service</string>
	</array>
	<key>Sockets</key>
	<dict>
		<key>` + launchdSocketKey + `</key>
		<dict>
			<key>SockPathName</key>
			<string>` + esc(socket) + `</string>
			<key>SockPathMode</key>
			<integer>438</integer>
		</dict>
	</dict>
	<key>AbandonProcessGroup</key>
	<true/>
	<key>AssociatedBundleIdentifiers</key>
	<array>
		<string>com.senawg.desktop</string>
	</array>
	<key>StandardErrorPath</key>
	<string>` + esc(stderrLog) + `</string>
</dict>
</plist>
`
}

// launchdSocketKey names the socket in the plist; launch_activate_socket asks for it by this name.
const launchdSocketKey = "Listener"
