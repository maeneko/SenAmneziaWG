; Registers the AmnesiaWG service (resources\win\awg-helper.exe) with the SCM. This is the only time the
; app asks for administrator rights: the installer is per-machine, so it is already elevated.

!macro customInstall
  DetailPrint "Установка службы AmnesiaWG…"
  nsExec::ExecToLog '"$INSTDIR\resources\win\awg-helper.exe" install'
  Pop $0
  ${If} $0 != 0
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONSTOP "Не удалось установить службу AmnesiaWG (код $0). Без неё приложение не сможет подключаться."
    ${EndIf}
    Abort
  ${EndIf}
!macroend

; Runs before the files are removed, both on uninstall and on an update (the old uninstaller is run first):
; stopping the service releases awg-helper.exe, which cannot be deleted while it runs. This also takes
; a running tunnel down and removes the service's data under ProgramData.
!macro customUnInstall
  DetailPrint "Остановка службы AmnesiaWG…"
  nsExec::ExecToLog '"$INSTDIR\resources\win\awg-helper.exe" uninstall'
  Pop $0
!macroend
