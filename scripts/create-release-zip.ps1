$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'
$releaseRoot = Join-Path $root 'release'
$version = (Get-Content (Join-Path $root 'package.json') | ConvertFrom-Json).version
$releaseDir = Join-Path $releaseRoot ("github-v" + $version)

if (-not (Test-Path $dist)) {
    throw "dist folder not found. Run npm run dist:win first."
}

New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null

$appFolder = Get-ChildItem -Path $dist -Directory | Where-Object { $_.Name -like 'SMTV Translation Editor-win32-*' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $appFolder) {
    throw "Packaged app folder not found in dist."
}

$appExe = Get-ChildItem -Path $appFolder.FullName -Filter '*.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $appExe) {
    throw "Application EXE not found in packaged app folder."
}

$readmeSource = Join-Path $root 'README.md'
$releaseNotes = Join-Path $releaseDir 'RELEASE-NOTES.txt'
$zipPath = Join-Path $releaseRoot ("SMTV-Translation-Editor-v" + $version + "-windows-x64.zip")

Copy-Item $appFolder.FullName -Destination (Join-Path $releaseDir $appFolder.Name) -Recurse -Force
Copy-Item $readmeSource -Destination (Join-Path $releaseDir 'README.md') -Force

@(
    "SMTV Translation Editor v$version"
    ""
    "Files:"
    "- $($appFolder.Name)\$($appExe.Name)"
    "- README.md"
    ""
    "Run:"
    "1. Extract the zip."
    "2. Open the extracted folder."
    "3. Double-click $($appExe.Name)."
    "4. The app will create its runtime data inside the app folder."
    ""
    "GitHub release artifact prepared automatically."
) | Set-Content -Path $releaseNotes -Encoding UTF8

if (Test-Path $zipPath) {
    Remove-Item $zipPath -Force
}

Compress-Archive -Path (Join-Path $releaseDir '*') -DestinationPath $zipPath -Force

Write-Host "Release directory: $releaseDir"
Write-Host "Release zip: $zipPath"

