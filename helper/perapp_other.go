//go:build !linux

package main

// perAppAvailable: rules by program exist only on Linux (cgroup v2 and nftables); elsewhere the table of routes
// does not know which program opened a connection.
func perAppAvailable() bool { return false }
