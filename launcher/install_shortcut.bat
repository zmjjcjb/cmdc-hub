@echo off
chcp 65001 >nul
setlocal

REM ============================================================
REM  安装 Windows 桌面快捷方式 + 开始菜单快捷方式
REM  双击运行即可，无需管理员权限
REM ============================================================

cd /d "%~dp0"
cd ..
set "PROJECT_DIR=%cd%"
set "ICON_FILE=%PROJECT_DIR%\launcher\cmdc-hub.ico"
set "BAT_FILE=%PROJECT_DIR%\launcher\start.bat"

REM 创建开始菜单快捷方式
set "START_MENU=%APPDATA%\Microsoft\Windows\Start Menu\Programs"
powershell -ExecutionPolicy Bypass -Command ^
  "$s = (New-Object -ComObject WScript.Shell).CreateShortcut('%START_MENU%\cmdc-hub.lnk');" ^
  "$s.TargetPath = '%BAT_FILE%';" ^
  "$s.WorkingDirectory = '%PROJECT_DIR%';" ^
  "$s.IconLocation = '%ICON_FILE%, 0';" ^
  "$s.Description = 'Command Code 反代网关';" ^
  "$s.Save()"

REM 创建桌面快捷方式
powershell -ExecutionPolicy Bypass -Command ^
  "$s = (New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop') + '\cmdc-hub.lnk');" ^
  "$s.TargetPath = '%BAT_FILE%';" ^
  "$s.WorkingDirectory = '%PROJECT_DIR%';" ^
  "$s.IconLocation = '%ICON_FILE%, 0';" ^
  "$s.Description = 'Command Code 反代网关';" ^
  "$s.Save()"

echo.
echo ✅ 快捷方式已安装：
echo    开始菜单: cmdc-hub
echo    桌面: cmdc-hub
echo.
echo 双击图标即可启动服务并打开 Dashboard
echo.
pause
