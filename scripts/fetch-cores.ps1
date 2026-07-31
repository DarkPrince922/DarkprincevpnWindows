# Скачивает то, что приложение не умеет делать само: ядро Xray, мост
# tun2socks и драйвер Wintun. Всё складывается в core/ рядом с exe.
#
# В репозитории эти файлы не хранятся: вместе они весят под сотню мегабайт,
# а обновляются независимо от приложения.

param(
    [string]$OutputDirectory = "$PSScriptRoot\..\artifacts\core",
    [string]$XrayVersion = "v26.7.28",
    [string]$Tun2SocksVersion = "v2.7.0",
    [string]$WintunVersion = "0.14.1"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$temp = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $temp | Out-Null

try {
    # --- Ядро Xray: ест тот же конфиг, что отдаёт панель ---
    Write-Host "Скачиваю Xray-core $XrayVersion…"
    $xrayZip = Join-Path $temp "xray.zip"
    Invoke-WebRequest -Uri "https://github.com/XTLS/Xray-core/releases/download/$XrayVersion/Xray-windows-64.zip" -OutFile $xrayZip
    Expand-Archive -Path $xrayZip -DestinationPath (Join-Path $temp "xray") -Force
    Copy-Item (Join-Path $temp "xray\xray.exe") $OutputDirectory -Force
    # базы geoip/geosite нужны правилам роутинга из конфига панели
    foreach ($dat in @("geoip.dat", "geosite.dat")) {
        $source = Join-Path $temp "xray\$dat"
        if (Test-Path $source) { Copy-Item $source $OutputDirectory -Force }
    }

    # --- Мост TUN → SOCKS ---
    Write-Host "Скачиваю tun2socks $Tun2SocksVersion…"
    $tunZip = Join-Path $temp "tun2socks.zip"
    Invoke-WebRequest -Uri "https://github.com/xjasonlyu/tun2socks/releases/download/$Tun2SocksVersion/tun2socks-windows-amd64.zip" -OutFile $tunZip
    Expand-Archive -Path $tunZip -DestinationPath (Join-Path $temp "tun2socks") -Force
    Copy-Item (Join-Path $temp "tun2socks\tun2socks-windows-amd64.exe") (Join-Path $OutputDirectory "tun2socks.exe") -Force

    # --- Драйвер виртуального адаптера ---
    # tun2socks грузит wintun.dll рядом с собой; без неё режим TUN не поднимется
    Write-Host "Скачиваю Wintun $WintunVersion…"
    $wintunZip = Join-Path $temp "wintun.zip"
    Invoke-WebRequest -Uri "https://www.wintun.net/builds/wintun-$WintunVersion.zip" -OutFile $wintunZip
    Expand-Archive -Path $wintunZip -DestinationPath (Join-Path $temp "wintun") -Force
    Copy-Item (Join-Path $temp "wintun\wintun\bin\amd64\wintun.dll") $OutputDirectory -Force

    Write-Host "Готово: $OutputDirectory"
    Get-ChildItem $OutputDirectory | Format-Table Name, Length
}
finally {
    Remove-Item -Recurse -Force $temp -ErrorAction SilentlyContinue
}
