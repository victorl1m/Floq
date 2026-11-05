; Floq NSIS installer hooks (bundle.windows.nsis.installerHooks in tauri.conf.json).
;
; Tauri's installer and uninstaller ask Windows Restart Manager to close a running floq.exe. When that
; fails (the app is still shutting down, a second instance, a window that is gone but a process that is
; not), floq.exe stays locked: the uninstaller cannot delete it and the installer's "uninstall previous
; version" step then reports that it was unable to uninstall. These hooks run first and make sure no
; floq.exe of this user is left (with its WebView2 child processes), then wait for the files to unlock.

!macro FLOQ_STOP_APP
  ; /T also ends the WebView2 children; /FI keeps it to the current user's processes (nsExec runs no
  ; shell, so the user name is read here instead of relying on %USERNAME% expansion).
  Push $0
  Push $1
  ReadEnvStr $1 USERNAME
  nsExec::Exec 'taskkill /F /T /IM "${MAINBINARYNAME}.exe" /FI "USERNAME eq $1"'
  Pop $0
  ; Give Windows a moment to release the file handles of whatever was ended.
  Sleep 1000
  Pop $1
  Pop $0
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro FLOQ_STOP_APP
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro FLOQ_STOP_APP
!macroend
