' Start hostguard at logon. Goes through start-hostguard.ps1 so the
' single-instance check runs and the child is created via WMI.
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & here & "\start-hostguard.ps1""", 0, False