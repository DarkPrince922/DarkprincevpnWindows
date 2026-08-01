# Проставляет версию приложения во все места, где она записана.
#
# Версия у релиза одна — из тега, — но лежит она в трёх файлах, и разъехаться
# им нельзя. Особенно важен tauri.conf.json: именно эту версию приложение
# сравнивает с манифестом обновлений. Если она отстаёт от выпущенной, апдейтер
# предлагает одно и то же обновление бесконечно.
#
#   ./scripts/set-version.ps1 -Version 1.2.0
#
# Руками файл менять не нужно: скрипт зовут из релизного workflow, а в
# репозитории остаётся версия последнего релиза.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Version
)

$ErrorActionPreference = 'Stop'

# тег приходит как v1.2.0, а в файлах версия без буквы
$version = $Version -replace '^v', ''
if ($version -notmatch '^\d+\.\d+\.\d+$') {
    throw "версия должна быть вида 1.2.0, а не «$version»"
}

$root = Split-Path -Parent $PSScriptRoot
$tauriDir = Join-Path $root 'app-tauri/src-tauri'

function Set-Version {
    param([string]$Path, [string]$Pattern, [string]$Replacement, [string]$What)

    if (-not (Test-Path $Path)) { throw "нет файла $Path" }
    $text = Get-Content $Path -Raw
    if ($text -notmatch $Pattern) { throw "в $Path не нашлось: $What" }

    # правим только первое совпадение: у зависимостей версии свои
    $patched = [regex]::Replace($text, $Pattern, $Replacement, 1)
    # без -NoNewline PowerShell допишет перевод строки к каждой правке
    Set-Content -Path $Path -Value $patched -NoNewline -Encoding UTF8
}

# tauri.conf.json: ключ "version" в файле один, поэтому правим строкой, а не
# перезаписью JSON целиком — так в файле не меняется ничего лишнего
Set-Version -Path (Join-Path $tauriDir 'tauri.conf.json') `
    -Pattern '"version": "[^"]*"' -Replacement "`"version`": `"$version`"" `
    -What 'ключ version'

# Cargo.toml: версия пакета — первая строка вида version = "...".
# У зависимостей версия записана внутри фигурных скобок и под шаблон не идёт.
Set-Version -Path (Join-Path $tauriDir 'Cargo.toml') `
    -Pattern '(?m)^version = "[^"]*"' -Replacement "version = `"$version`"" `
    -What 'версия пакета'

# Cargo.lock: иначе cargo с --locked справедливо ругается, что замок разошёлся
# с Cargo.toml. Версию правим только внутри блока своего пакета.
Set-Version -Path (Join-Path $tauriDir 'Cargo.lock') `
    -Pattern '(?ms)(\[\[package\]\]\r?\nname = "darkprince-vpn"\r?\nversion = ")[^"]*(")' `
    -Replacement "`${1}$version`${2}" `
    -What 'пакет darkprince-vpn'

Write-Host "версия $version проставлена"
Select-String -Path (Join-Path $tauriDir 'tauri.conf.json') -Pattern '"version"' |
    Select-Object -First 1 | ForEach-Object { $_.Line.Trim() }
