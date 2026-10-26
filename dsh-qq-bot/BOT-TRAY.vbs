' ============================================================
'  BOT-TRAY.vbs -- start the dsh-qq-bot tray icon with NO window
'
'  Double-click this file. There is no console window, no flash on
'  screen, no taskbar entry: WScript launches powershell.exe with
'  window style 0 (hidden) and never waits for it.
'
'  Why a .vbs and not a .cmd: a .cmd always opens a console
'  (conhost) first and can only hide it afterwards, so you still
'  see a black box flash -- and Start-Process -WindowStyle Hidden
'  cannot hide a console that was already created. WScript's
'  Shell.Run with intWindowStyle=0 never creates one.
'
'  It finds bot-tray.ps1 next to itself, in .\scripts\, or in
'  .\tools\ -- so the same file works both in a dev checkout and
'  inside a published release package.
' ============================================================
Option Explicit

Dim fso, sh, root, target, cmd

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

root = fso.GetParentFolderName(WScript.ScriptFullName)
target = ""

If fso.FileExists(root & "\bot-tray.ps1") Then
  target = root & "\bot-tray.ps1"
ElseIf fso.FileExists(root & "\scripts\bot-tray.ps1") Then
  target = root & "\scripts\bot-tray.ps1"
ElseIf fso.FileExists(root & "\tools\bot-tray.ps1") Then
  target = root & "\tools\bot-tray.ps1"
End If

If target = "" Then
  MsgBox "Cannot find bot-tray.ps1 near:" & vbCrLf & root & vbCrLf & vbCrLf & _
         "Keep BOT-TRAY.vbs in the same folder as the scripts folder.", 16, "dsh-qq-bot"
  WScript.Quit 1
End If

cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & target & """"

' 0 = hidden window, False = do not wait for it to exit
sh.Run cmd, 0, False
