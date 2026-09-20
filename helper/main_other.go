//go:build !windows

// The helper only does something on Windows; this keeps `go build ./...` and `go vet ./...` working
// on the other platforms, where the portable packages under internal/ are tested.
package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "awg-helper works on Windows only")
	os.Exit(2)
}
