' 静默启动自建通道（reader.py + server.mjs），不弹任何黑框
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
ps = "C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe"
Set shell = CreateObject("WScript.Shell")
shell.Run """" & ps & """ -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & base & "\scripts\start-services.ps1""", 0, False
