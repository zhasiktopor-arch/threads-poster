$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$Base = Join-Path $env:LOCALAPPDATA 'ThreadsPoster'
Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -and ($_.CommandLine -like '*ThreadsPoster\start-hidden.vbs*' -or $_.CommandLine -like '*ThreadsPoster\app\server.js*')
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Remove-Item (Join-Path ([Environment]::GetFolderPath('Startup'))  'Threads Poster (фон).lnk') -Force
Remove-Item (Join-Path ([Environment]::GetFolderPath('Desktop'))  'Threads Poster.lnk') -Force
Remove-Item (Join-Path ([Environment]::GetFolderPath('Programs')) 'Threads Poster.lnk') -Force
Remove-Item $Base -Recurse -Force
Write-Host 'Программа удалена.'
Write-Host "Ваши посты и токен сохранены в $env:APPDATA\ThreadsPoster. Чтобы стереть и их, удалите эту папку вручную."
