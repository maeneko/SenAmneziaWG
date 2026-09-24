//go:build !windows && !linux

// The helper only does something on Windows and Linux; this keeps `go build ./...` and `go vet ./...`
// working on other platforms (macOS, where the app instead drives resources/scripts/awg.sh directly),
// so the portable packages under internal/ are still built and tested there.
package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "awg-helper works on Windows and Linux only")
	os.Exit(2)
}
