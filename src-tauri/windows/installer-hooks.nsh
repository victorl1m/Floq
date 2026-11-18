; Floq NSIS installer hooks (bundle.windows.nsis.installerHooks in tauri.conf.json).
;
; The Rust autostart plugin owns startup registration. Its configured app name is "Floq"; the locked
; plugin (tauri-plugin-autostart 2.7.0 / auto-launch 0.6.0) stores that value under the current
; user's Software\Microsoft\Windows\CurrentVersion\Run key. This hook only removes that exact
; value on uninstall. During replacement installs the marker preserves it for the new version.
!define FLOQ_UPGRADE_MARKER "$TEMP\Floq-nsis-upgrade-in-progress.flag"

; Tauri's installer and uninstaller ask Windows Restart Manager to close a running floq.exe. When that
; fails (the app is still shutting down, a second instance, a window that is gone but a process that is
; not), floq.exe stays locked: the uninstaller cannot delete it and the installer's "uninstall previous
; version" step then reports that it was unable to uninstall. These hooks run first and make sure no
; floq.exe of this user is left (with its WebView2 child processes), then wait for the files to unlock.

; Leaves 1 in $0 when floq.exe of this user runs, else 0. Uses tasklist through nsExec (stock NSIS):
; with /NH /FO CSV a match prints a line that starts with a double quote ("floq.exe",...), while no
; match prints a localized "INFO: ..." sentence, so the first character tells them apart. Needs $1 =
; user name; clobbers $0, $2, $3.
!macro FLOQ_IS_RUNNING
  nsExec::ExecToStack 'tasklist /FI "IMAGENAME eq ${MAINBINARYNAME}.exe" /FI "USERNAME eq $1" /NH /FO CSV'
  Pop $0
  Pop $2
  StrCpy $3 $2 1
  ${If} $3 == '"'
    StrCpy $0 1
  ${Else}
    StrCpy $0 0
  ${EndIf}
!macroend

!macro FLOQ_STOP_APP
  ; Fast path: nothing to stop when floq.exe is not running (fresh install, or uninstall after the app
  ; was closed). The user name is read here because nsExec runs no shell to expand %USERNAME%.
  Push $0
  Push $1
  Push $2
  Push $3
  ReadEnvStr $1 USERNAME
  !insertmacro FLOQ_IS_RUNNING
  ${If} $0 == 1
    ; /T also ends the WebView2 children; /FI keeps it to the current user's processes.
    nsExec::Exec 'taskkill /F /T /IM "${MAINBINARYNAME}.exe" /FI "USERNAME eq $1"'
    Pop $0
    ; Poll instead of a fixed Sleep: leave as soon as the process is gone, at most 15 x 200 ms = 3 s,
    ; then continue anyway like the old fixed wait did.
    StrCpy $3 0
    floq_wait_loop:
      Sleep 200
      !insertmacro FLOQ_IS_RUNNING
      ${If} $0 == 0
        Goto floq_wait_done
      ${EndIf}
      IntOp $3 $3 + 1
      ${If} $3 < 15
        Goto floq_wait_loop
      ${EndIf}
    floq_wait_done:
  ${EndIf}
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; The old version's uninstaller runs as part of an upgrade. Preserve its plugin-owned Run value.
  FileOpen $0 "${FLOQ_UPGRADE_MARKER}" w
  FileWrite $0 "Floq NSIS replacement install"
  FileClose $0
  !insertmacro FLOQ_STOP_APP
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Delete "${FLOQ_UPGRADE_MARKER}"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; During an upgrade the installer's PREINSTALL hook has just stopped the app: skip the second
  ; kill and wait. Keep the registration; the new process rechecks it.
  IfFileExists "${FLOQ_UPGRADE_MARKER}" floq_upgrade_uninstall 0
  !insertmacro FLOQ_STOP_APP
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Floq"
  floq_upgrade_uninstall:
!macroend
