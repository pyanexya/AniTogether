# SPDX-License-Identifier: GPL-2.0-only
# Windows-only smoke tests. The fixture NEVER installs the actual application.
$ErrorActionPreference = 'Stop'
$previewDirectory = Join-Path (Split-Path $PSScriptRoot -Parent) 'dist/installer-preview'
New-Item -ItemType Directory -Force $previewDirectory | Out-Null
[IO.File]::WriteAllText((Join-Path $previewDirectory 'README.txt'), @'
Windows WinForms renderer evidence (DrawToBitmap), NOT a desktop screenshot.
Only the installer form and its own controls are rendered; no runner desktop or other windows are captured.
Fixture payload is harmless. No actual application installation occurs.
Preview intentionally disables installation. Two PNGs capture different animation times.
These native-runner-DPI renders do not establish 150%/200% DPI or Windows 10 coverage.
'@)
function Pump-PreviewMessages([int]$Milliseconds) {
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while ($clock.ElapsedMilliseconds -lt $Milliseconds) {
        [Windows.Forms.Application]::DoEvents()
        [Threading.Thread]::Sleep(15)
    }
}
function Save-PreviewBitmap($Control, [string]$Path) {
    $bitmap = [Drawing.Bitmap]::new($Control.Width, $Control.Height)
    try {
        $Control.DrawToBitmap($bitmap, [Drawing.Rectangle]::new(0, 0, $Control.Width, $Control.Height))
        $bitmap.Save($Path, [Drawing.Imaging.ImageFormat]::Png)
    } finally { $bitmap.Dispose() }
}
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
    Add-Type -AssemblyName System.Windows.Forms
    $image = [Drawing.Image]::FromStream($resource)
    try {
        $frames = $image.GetFrameCount([Drawing.Imaging.FrameDimension]::Time)
        if ($frames -ne 239) { throw "Expected original 239-frame GIF, got $frames" }
        if (![Drawing.ImageAnimator]::CanAnimate($image)) { throw 'GIF is not animated' }
    } finally { $image.Dispose(); $resource.Dispose() }
    # Construct the actual preview form/resources without starting an install.
    $formType = $assembly.GetType('SetupForm')
    $constructor = $formType.GetConstructor([Reflection.BindingFlags]'NonPublic,Instance', $null, [Type[]]@([bool]), $null)
    [Windows.Forms.Application]::EnableVisualStyles()
    $form = $constructor.Invoke(@($true))
    try {
        $form.Show()
        if ($form.Text -notlike 'AnixArtix*') { throw 'Preview form did not initialize' }
        $mascot = @($form.Controls | Where-Object { $_.GetType().Name -eq 'AnimatedMascot' })[0]
        if (!$mascot) { throw 'Animated mascot control is missing' }
        Pump-PreviewMessages 400
        Save-PreviewBitmap $form (Join-Path $previewDirectory 'setup-frame-1.png')
        $mascotFrame1 = Join-Path $previewDirectory 'mascot-frame-1.png'
        Save-PreviewBitmap $mascot $mascotFrame1
        Pump-PreviewMessages 1400
        Save-PreviewBitmap $form (Join-Path $previewDirectory 'setup-frame-2.png')
        $mascotFrame2 = Join-Path $previewDirectory 'mascot-frame-2.png'
        Save-PreviewBitmap $mascot $mascotFrame2
        if ((Get-FileHash $mascotFrame1).Hash -eq (Get-FileHash $mascotFrame2).Hash) { throw 'Mascot did not visibly animate between captured frames' }
        foreach ($control in $form.Controls) {
            if ($control.Left -lt 0 -or $control.Top -lt 0 -or $control.Right -gt $form.ClientSize.Width -or $control.Bottom -gt $form.ClientSize.Height) {
                throw "Control outside installer client bounds: $($control.GetType().Name) / $($control.Text)"
            }
        }
        [IO.File]::WriteAllText((Join-Path $previewDirectory 'verification.txt'), "PASS: two visibly different GIF frames and all control bounds fit the client area.`r`nClient size: $($form.ClientSize.Width)x$($form.ClientSize.Height).`r`nAutoScaleDimensions: $($form.AutoScaleDimensions).`r`nRenderer only; visually inspect PNGs before release. No actual install performed.`r`n")
    } finally { $form.Dispose() }
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
