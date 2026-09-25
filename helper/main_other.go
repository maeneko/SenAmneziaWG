//go:build !windows && !linux && !darwin

// The helper only does something on Windows, Linux and macOS; this keeps `go build ./...` and
// `go vet ./...` working anywhere else, so the portable packages under internal/ still build there.
package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "awg-helper works on Windows, Linux and macOS only")
	os.Exit(2)
}
