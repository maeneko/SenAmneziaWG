package setup

import (
	"errors"
	"fmt"
	"strconv"
)

// Args is what the app passes to `awg-helper setup`.
type Args struct {
	// From is the unpacked application (the directory of the running SenAWG.exe).
	From string
	// To is where the user wants the application.
	To string
	// Progress is the file the app follows; empty means «report nowhere».
	Progress string
	// UpdateWaitPID is the running application this update replaces (0: a plain install or the older,
	// visible update). Set, `setup` copies the new version beside the old one first, says so (Reporter.Staged),
	// waits for that process to exit, and only then swaps the folders — so the application stays usable
	// while the slow part runs (see swap.go).
	UpdateWaitPID uint32
}

const Usage = "setup --app-from <dir> --app-to <dir> [--progress <file>] [--update-wait-pid <pid>]"

// ParseArgs reads the arguments after the `setup` verb. Unknown flags are an error rather than ignored:
// this process is elevated, and a typo should not turn into a silently different install.
func ParseArgs(args []string) (Args, error) {
	var a Args
	for i := 0; i < len(args); i += 2 {
		if i+1 >= len(args) {
			return Args{}, fmt.Errorf("%s: нет значения", args[i])
		}
		switch args[i] {
		case "--app-from":
			a.From = args[i+1]
		case "--app-to":
			a.To = args[i+1]
		case "--progress":
			a.Progress = args[i+1]
		case "--update-wait-pid":
			pid, err := strconv.ParseUint(args[i+1], 10, 32)
			if err != nil || pid == 0 {
				return Args{}, fmt.Errorf("--update-wait-pid: нужен номер процесса")
			}
			a.UpdateWaitPID = uint32(pid)
		default:
			return Args{}, fmt.Errorf("неизвестный параметр %s", args[i])
		}
	}
	if a.From == "" || a.To == "" {
		return Args{}, errors.New(Usage)
	}
	return a, nil
}
