# SPDX-License-Identifier: GPL-2.0-only
param([string]$Payload, [string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
if (!$Payload) {
    $candidates = @(Get-ChildItem "$root/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*-setup.exe")
    if ($candidates.Count -ne 1) { throw 'Expected exactly one Tauri NSIS payload; clean old bundles or pass -Payload.' }
    $Payload = $candidates[0].FullName
}
$Payload = (Resolve-Path $Payload).Path
if (!$OutputDirectory) { $OutputDirectory = Join-Path $root 'dist/installer' }
New-Item -ItemType Directory -Force $OutputDirectory | Out-Null
$OutputDirectory = (Resolve-Path $OutputDirectory).Path
$config = Get-Content "$root/src-tauri/tauri.conf.json" -Raw | ConvertFrom-Json
if ($config.bundle.windows.nsis.installMode -ne 'currentUser') { throw 'Wrapper requires currentUser NSIS installation.' }
$version = $config.version
if ($version -notmatch '^\d+\.\d+\.\d+([+-][a-zA-Z0-9.-]+)?$') { throw 'Unsafe version for output filename.' }
$output = Join-Path $OutputDirectory "AnixArtix_${version}_x64-setup.exe"
$csc = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (!(Test-Path $csc)) { throw 'Microsoft .NET Framework C# compiler is required (Windows 10/11 build host).' }
$hashFile = Join-Path $OutputDirectory 'payload.sha256'
[IO.File]::WriteAllText($hashFile, (Get-FileHash $Payload -Algorithm SHA256).Hash)
# Resolve compiler inputs to native Windows paths. Legacy Framework csc does not
# reliably normalize mixed slash paths; fail before compilation if any input is absent.
$sourcePath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'Setup.cs')).Path
$manifestPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'setup.manifest')).Path
$iconPath = (Resolve-Path -LiteralPath (Join-Path $root 'icon\icon.ico')).Path
$gifPath = (Resolve-Path -LiteralPath (Join-Path $root 'icon\install-anim.gif')).Path
$licensePath = (Resolve-Path -LiteralPath (Join-Path $root 'LICENSE')).Path
$noticePath = (Resolve-Path -LiteralPath (Join-Path $root 'FORK-NOTICE.md')).Path
try {
    $compilerArguments = @(
        '/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/warnaserror+', '/utf8output', '/codepage:65001',
        "/out:$output", "/win32manifest:$manifestPath", "/win32icon:$iconPath",
        '/reference:System.dll', '/reference:System.Core.dll', '/reference:System.Drawing.dll', '/reference:System.Windows.Forms.dll',
        "/resource:$Payload,payload.exe", "/resource:$hashFile,payload.sha256",
        "/resource:$gifPath,install-anim.gif", "/resource:$iconPath,app.ico",
        "/resource:$licensePath,LICENSE", "/resource:$noticePath,FORK-NOTICE.md", $sourcePath
    )
    Write-Host "Compiling setup source: $sourcePath"
    & $csc @compilerArguments
    if ($LASTEXITCODE -ne 0) { throw "Setup compilation failed: $LASTEXITCODE" }
    $hash = (Get-FileHash $output -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText("$output.sha256", "$hash  $([IO.Path]::GetFileName($output))`n")
    Write-Host "Custom animated setup: $output ($((Get-Item $output).Length) bytes)"
} finally { Remove-Item $hashFile -ErrorAction SilentlyContinue }
