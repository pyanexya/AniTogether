# SPDX-License-Identifier: GPL-2.0-only
# Windows-only smoke tests. The fixture NEVER installs the actual application.
$ErrorActionPreference = 'Stop'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('AnixArtixSetupTest-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $testRoot | Out-Null
try {
    $fixture = Join-Path $testRoot 'fixture.cs'
    [IO.File]::WriteAllText($fixture, 'class Fixture { static int Main(string[] args) { if (args.Length != 1 || args[0] != "/S") return 99; return int.Parse(System.Environment.GetEnvironmentVariable("ANIXARTIX_TEST_EXIT")); } }')
    $csc = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    & $csc /nologo /target:exe "/out:$testRoot/fixture.exe" $fixture
    if ($LASTEXITCODE -ne 0) { throw 'Fixture compilation failed' }
    & "$PSScriptRoot/build.ps1" -Payload "$testRoot/fixture.exe" -OutputDirectory "$testRoot/output"
    $exe = @(Get-ChildItem "$testRoot/output/*-setup.exe")[0]
    $assembly = [Reflection.Assembly]::LoadFile($exe.FullName)
    $resource = $assembly.GetManifestResourceStream('install-anim.gif')
    Add-Type -AssemblyName System.Drawing
    $image = [Drawing.Image]::FromStream($resource)
    try {
        $frames = $image.GetFrameCount([Drawing.Imaging.FrameDimension]::Time)
        if ($frames -ne 239) { throw "Expected original 239-frame GIF, got $frames" }
        if (![Drawing.ImageAnimator]::CanAnimate($image)) { throw 'GIF is not animated' }
    } finally { $image.Dispose(); $resource.Dispose() }
    $run = $assembly.GetType('SetupForm').GetMethod('RunPayload', [Reflection.BindingFlags]'NonPublic,Static')
    $before = @(Get-ChildItem ([IO.Path]::GetTempPath()) -Directory -Filter 'AnixArtix-*' | ForEach-Object Name)
    foreach ($exitCode in @(0, 1, 2, 3010, 1641)) {
        $env:ANIXARTIX_TEST_EXIT = [string]$exitCode
        $actual = $run.Invoke($null, @())
        if ($actual -ne $exitCode) { throw "Exit code changed: $exitCode -> $actual" }
    }
    $leaks = @(Get-ChildItem ([IO.Path]::GetTempPath()) -Directory -Filter 'AnixArtix-*' | Where-Object { $_.Name -notin $before })
    if ($leaks.Count) { throw 'Payload temporary files were not cleaned up' }
    Write-Host 'PASS: original GIF, compilation, silent argument, success/failure/reboot codes and cleanup.'
} finally {
    Remove-Item Env:ANIXARTIX_TEST_EXIT -ErrorAction SilentlyContinue
    # Loaded .NET assembly can remain locked until PowerShell exits. Best-effort removal.
    Remove-Item $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
