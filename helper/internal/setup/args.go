package setup

import (
	"errors"
	"fmt"
)

// Args is what the app passes to `awg-helper setup`.
type Args struct {
	// From is the unpacked application (the directory of the running AmnesiaWG.exe).
	From string
	// To is where the user wants the application.
	To string
	// Progress is the file the app follows; empty means «report nowhere».
	Progress string
}

const Usage = "setup --app-from <dir> --app-to <dir> [--progress <file>]"

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
		default:
			return Args{}, fmt.Errorf("неизвестный параметр %s", args[i])
		}
	}
	if a.From == "" || a.To == "" {
		return Args{}, errors.New(Usage)
	}
	return a, nil
}
