# Установка / обновление Threads Poster для Windows.
# Посты и токен хранятся в %APPDATA%\ThreadsPoster и при обновлении не теряются.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$Src    = Split-Path -Parent $PSCommandPath
$Base   = Join-Path $env:LOCALAPPDATA 'ThreadsPoster'
$AppDir = Join-Path $Base 'app'
$Port   = 7790
$Url    = "http://127.0.0.1:$Port"

Write-Host '== Устанавливаю Threads Poster ==' -ForegroundColor Cyan

# 1. Останавливаем старую копию, если запущена
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -and ($_.CommandLine -like '*ThreadsPoster\start-hidden.vbs*' -or $_.CommandLine -like '*ThreadsPoster\app\server.js*')
} | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }
Start-Sleep -Milliseconds 500

# 2. Копируем программу
New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
Copy-Item -Path (Join-Path $Src '*') -Destination $AppDir -Recurse -Force
Get-ChildItem $AppDir -Recurse | Unblock-File -ErrorAction SilentlyContinue

# 3. Node.js 22.13+ (нужна встроенная база). Если нет — качаем официальный с nodejs.org
function Test-Node([string]$p) {
  if (-not $p -or -not (Test-Path $p)) { return $false }
  & $p -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)" 2>$null
  return ($LASTEXITCODE -eq 0)
}
$Node = $null
$cmd = Get-Command node -ErrorAction SilentlyContinue
if ($cmd -and (Test-Node $cmd.Source)) { $Node = $cmd.Source }
if (-not $Node) {
  $Node = Join-Path $Base 'node\node.exe'
  if (-not (Test-Node $Node)) {
    $v = 'v24.11.1'
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
    $zip = Join-Path $env:TEMP "node-$v-win-$arch.zip"
    Write-Host "Скачиваю Node.js $v с nodejs.org (~30 МБ), подождите..."
    Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$v/node-$v-win-$arch.zip" -OutFile $zip
    $tmp = Join-Path $Base '_node'
    Remove-Item (Join-Path $Base 'node') -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    Move-Item (Join-Path $tmp "node-$v-win-$arch") (Join-Path $Base 'node')
    Remove-Item $tmp -Recurse -Force
    Remove-Item $zip -Force
  }
}
Write-Host ("Node: " + (& $Node -v))

# 4. Скрытый запуск: перезапускает программу, если она упала; код 3 = уже запущена
$Server   = Join-Path $AppDir 'server.js'
$StartVbs = Join-Path $Base 'start-hidden.vbs'
$vbs = @"
Set sh = CreateObject("WScript.Shell")
sh.Environment("Process")("PORT") = "$Port"
cmd = """$Node"" --no-warnings ""$Server"""
Do
  rc = sh.Run(cmd, 0, True)
  If rc = 3 Then Exit Do
  WScript.Sleep 3000
Loop
"@
Set-Content -Path $StartVbs -Value $vbs -Encoding Unicode

$OpenVbs = Join-Path $Base 'open.vbs'
$vbs2 = @"
Set sh = CreateObject("WScript.Shell")
sh.Run "wscript.exe ""$StartVbs""", 0, False
WScript.Sleep 1500
sh.Run "$Url"
"@
Set-Content -Path $OpenVbs -Value $vbs2 -Encoding Unicode

# 5. Ярлыки: автозагрузка, рабочий стол, меню «Пуск»
$ws = New-Object -ComObject WScript.Shell
$Ico = Join-Path $AppDir 'icon.ico'
$Wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
function New-Link([string]$LinkPath, [string]$Arguments) {
  $l = $ws.CreateShortcut($LinkPath)
  $l.TargetPath = $Wscript
  $l.Arguments = $Arguments
  $l.WorkingDirectory = $Base
  $l.IconLocation = $Ico
  $l.Save()
}
New-Link (Join-Path ([Environment]::GetFolderPath('Startup'))  'Threads Poster (фон).lnk') "`"$StartVbs`""
New-Link (Join-Path ([Environment]::GetFolderPath('Desktop'))  'Threads Poster.lnk')       "`"$OpenVbs`""
New-Link (Join-Path ([Environment]::GetFolderPath('Programs')) 'Threads Poster.lnk')       "`"$OpenVbs`""

# 6. Запуск
Start-Process $Wscript -ArgumentList "`"$StartVbs`""
$ok = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 500
  try { Invoke-WebRequest -UseBasicParsing $Url -TimeoutSec 2 | Out-Null; $ok = $true; break } catch {}
}
if ($ok) {
  Start-Process $Url
  Write-Host ''
  Write-Host 'Готово! Значок «Threads Poster» — на рабочем столе и в меню «Пуск».' -ForegroundColor Green
  Write-Host 'Программа запускается сама при включении компьютера. Это окно можно закрыть.'
} else {
  Write-Host 'Программа не ответила. Попробуйте открыть значок «Threads Poster» на рабочем столе.' -ForegroundColor Yellow
  Write-Host "Чтобы увидеть ошибку, запустите вручную: `"$Node`" `"$Server`""
}
