//go:build darwin

package main

import (
	"fmt"
	"os"
	"strings"

	"senawg-helper/internal/proto"
)

// svcLog appends one of the service's own lines to awg.sh's daemon.log, which the app already follows
// (macosBackend.ts), in the "LEVEL: " form parseDaemonLine reads — as diag_linux.go does on Linux.
// awg.sh starts that file afresh on every `up`, so up logs only after the script has run.
func svcLog(level, format string, args ...any) {
	f, err := os.OpenFile(daemonLogPath(), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	msg := strings.ReplaceAll(fmt.Sprintf(format, args...), "\n", " | ")
	fmt.Fprintf(f, "%s: служба: %s\n", level, msg)
}

func svcInfo(format string, args ...any)  { svcLog("INFO", format, args...) }
func svcWarn(format string, args ...any)  { svcLog("WARNING", format, args...) }
func svcError(format string, args ...any) { svcLog("ERROR", format, args...) }

// Nothing asks for it on macOS yet (macosBackend.ts has no network probe); answered, not a panic.
func init() {
	netInfoFunc = func(string) (*proto.Response, error) {
		return nil, proto.Errf(proto.CodeBadRequest, "Проверка сети через службу на macOS не поддерживается")
	}
}
