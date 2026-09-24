package setup

import "fmt"

// The steps the in-app removal screen shows, in order: the setup's own, run backwards
// (src/renderer/src/components/RemoveScreen.tsx).
const (
	RemoveStepStop    = 0 // «Отключение и остановка службы»
	RemoveStepService = 1 // «Служба подключения»
	RemoveStepFiles   = 2 // «Файлы программы»
)

// RemoveArgs is what `awg-helper remove` accepts.
type RemoveArgs struct {
	// Finish marks the copy in %TEMP% that does the work (the installed copy cannot delete itself).
	Finish bool
	// Progress is the file the app follows. Set only when the app itself runs the removal: then the app
	// is still on screen showing it, so it is reported to rather than closed, and nothing pops up.
	Progress string
	// KeepSecrets (Linux): «сохранить серверы и ключи» — the tunnel keys the service keeps in
	// /var/lib/senawg/secrets stay, like the app's own data does, for a later reinstall.
	KeepSecrets bool
}

const RemoveUsage = "remove [--progress <file>] [--keep-secrets]"

// ParseRemoveArgs reads the arguments after the `remove` verb. As with setup, an unknown flag is an
// error: this process is elevated.
func ParseRemoveArgs(args []string) (RemoveArgs, error) {
	var a RemoveArgs
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--finish":
			a.Finish = true
		case "--keep-secrets":
			a.KeepSecrets = true
		case "--progress":
			if i+1 >= len(args) || args[i+1] == "" {
				return RemoveArgs{}, fmt.Errorf("--progress: нет значения")
			}
			i++
			a.Progress = args[i]
		default:
			return RemoveArgs{}, fmt.Errorf("неизвестный параметр %s", args[i])
		}
	}
	return a, nil
}

// Args gives the arguments back, for the hand-over to the copy in %TEMP%.
func (a RemoveArgs) Args() []string {
	var out []string
	if a.Finish {
		out = append(out, "--finish")
	}
	if a.Progress != "" {
		out = append(out, "--progress", a.Progress)
	}
	if a.KeepSecrets {
		out = append(out, "--keep-secrets")
	}
	return out
}
