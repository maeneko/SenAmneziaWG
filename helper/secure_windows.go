package main

import (
	"errors"
	"fmt"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Owner and group SYSTEM, protected (no inherited entries). Full control for SYSTEM and Administrators;
// the base directory also lets Users read, so daemon.log can be followed without privileges.
const (
	baseSDDL    = "O:SYG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)"
	privateSDDL = "O:SYG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
)

// ensure creates the directories and takes them over. Anyone may create C:\ProgramData\SenAWG
// before the installer does, so an existing directory is not trusted: its owner and ACL are replaced,
// and a junction or symlink standing in for it is removed.
func (d dirs) ensure() error {
	for _, step := range []struct{ path, sddl string }{{d.base, baseSDDL}, {d.data, privateSDDL}, {d.tunnels, privateSDDL}} {
		if err := secureDir(step.path, step.sddl); err != nil {
			return fmt.Errorf("%s: %w", step.path, err)
		}
	}
	return nil
}

func secureDir(path, sddl string) error {
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return err
	}
	path16, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	sa := &windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}

	for attempt := 0; attempt < 3; attempt++ {
		if err := windows.CreateDirectory(path16, sa); err != nil && !errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
			return err
		}
		h, err := windows.CreateFile(path16, windows.READ_CONTROL|windows.WRITE_OWNER|windows.WRITE_DAC,
			windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING,
			windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
		if err != nil {
			return err
		}
		var info windows.ByHandleFileInformation
		err = windows.GetFileInformationByHandle(h, &info)
		if err == nil && info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 {
			err = errors.New("не каталог")
		}
		if err == nil && info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			// os.Remove on a junction removes the link, never its target.
			windows.CloseHandle(h)
			if rerr := os.Remove(path); rerr != nil {
				return rerr
			}
			continue
		}
		if err == nil {
			err = windows.SetKernelObjectSecurity(h, windows.OWNER_SECURITY_INFORMATION|windows.GROUP_SECURITY_INFORMATION|
				windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, sd)
		}
		windows.CloseHandle(h)
		return err
	}
	return errors.New("не удалось создать каталог")
}
