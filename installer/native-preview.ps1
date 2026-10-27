# SPDX-License-Identifier: GPL-2.0-only
# CI-only visual smoke: launch the built client, never an installer. No credentials supplied.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$directory = Join-Path $root 'dist/native-preview'
New-Item -ItemType Directory -Force $directory | Out-Null
$reportPath = Join-Path $directory 'verification.txt'
[IO.File]::WriteAllText($reportPath, "Native Windows startup capture pending.`r`n")
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
public static class AnixArtixWindowCapture {
    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out RECT rect);
    [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    public static Bitmap Capture(IntPtr window) {
        RECT rect;
        if (!GetWindowRect(window, out rect)) throw new InvalidOperationException("GetWindowRect failed.");
        int width = rect.Right - rect.Left, height = rect.Bottom - rect.Top;
        if (width < 100 || height < 100 || width > 8192 || height > 8192) throw new InvalidOperationException("Invalid window dimensions.");
        Bitmap bitmap = new Bitmap(width, height);
        try {
            using (Graphics graphics = Graphics.FromImage(bitmap)) {
                IntPtr dc = graphics.GetHdc();
                try {
                    // PW_RENDERFULLCONTENT: ask only this window to paint into our bitmap.
                    // Never use CopyFromScreen: other windows/desktop must not enter this artifact.
                    if (!PrintWindow(window, dc, 2)) throw new InvalidOperationException("PrintWindow failed; CI session may not support window capture.");
                } finally { graphics.ReleaseHdc(dc); }
            }
            return bitmap;
        } catch { bitmap.Dispose(); throw; }
    }
}
'@ -ReferencedAssemblies System.Drawing
$process = $null
try {
    $app = (Resolve-Path -LiteralPath (Join-Path $root 'src-tauri/target/x86_64-pc-windows-msvc/release/anixartix.exe')).Path
    $statePath = Join-Path $directory 'startup-state.json'
    if (Test-Path -LiteralPath $statePath) { Remove-Item -LiteralPath $statePath -Force }
    $previousSmokeDirectory = [Environment]::GetEnvironmentVariable('ANIXARTIX_SMOKE_DIR', 'Process')
    try {
        [Environment]::SetEnvironmentVariable('ANIXARTIX_SMOKE_DIR', (Resolve-Path -LiteralPath $directory).Path, 'Process')
        $process = Start-Process -FilePath $app -WorkingDirectory (Split-Path $app -Parent) -PassThru
    } finally {
        [Environment]::SetEnvironmentVariable('ANIXARTIX_SMOKE_DIR', $previousSmokeDirectory, 'Process')
    }
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $window = [IntPtr]::Zero
    while ($clock.Elapsed.TotalSeconds -lt 30) {
        $process.Refresh()
        if ($process.HasExited) { throw "Built client exited before a visible window (exit $($process.ExitCode))." }
        $window = $process.MainWindowHandle
        if ($window -ne [IntPtr]::Zero -and [AnixArtixWindowCapture]::IsWindowVisible($window)) { break }
        Start-Sleep -Milliseconds 250
    }
    if ($window -eq [IntPtr]::Zero -or ![AnixArtixWindowCapture]::IsWindowVisible($window)) { throw 'No visible client window within 30 seconds. CI interactive session/startup may be unavailable.' }
    # Read only the fixed native diagnostic file. A splash/colour count is not readiness.
    $ready = $false
    $lastStage = 'none'
    $startupFailure = $null
    while ($clock.Elapsed.TotalSeconds -lt 60) {
        $process.Refresh()
        if ($process.HasExited) { throw "Client exited before app-mounted (exit $($process.ExitCode))." }
        if (Test-Path -LiteralPath $statePath) {
            try {
                $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
                if ($state.schema -eq 1 -and $state.pid -eq $process.Id) {
                    # Only enum values from native code enter the report; never arbitrary diagnostics.
                    if ($state.stage -in @('native-started', 'bootstrap-started', 'settings-ready', 'app-loaded', 'mount-started', 'app-mounted', 'failed')) {
                        $lastStage = $state.stage
                        if ($lastStage -eq 'app-mounted') { $ready = $true; break }
                        if ($lastStage -eq 'failed') { $startupFailure = 'Native startup reported failed.'; break }
                    }
                }
            } catch {
                # The writer may be atomically replacing the file; retry without accepting stale state.
            }
        }
        Start-Sleep -Milliseconds 250
    }
    if (!$ready -and !$startupFailure) { $startupFailure = "No matching native app-mounted state within 60 seconds (last stage: $lastStage)." }
    # Capture the launched HWND even on readiness failure, for diagnosis, never the desktop.
    if ($ready) { Start-Sleep -Seconds 2 }
    $process.Refresh()
    if ($process.HasExited) { throw "Client exited before capture (exit $($process.ExitCode))." }
    $bitmap = [AnixArtixWindowCapture]::Capture($window)
    try {
        $bitmap.Save((Join-Path $directory 'native-first-window.png'), [Drawing.Imaging.ImageFormat]::Png)
        $colors = [Collections.Generic.HashSet[int]]::new()
        for ($y = 20; $y -lt $bitmap.Height - 20; $y += 12) {
            for ($x = 20; $x -lt $bitmap.Width - 20; $x += 12) { [void]$colors.Add($bitmap.GetPixel($x, $y).ToArgb()) }
        }
        $result = "Native startup readiness: $ready; stage: $lastStage; matched process: $($process.Id).`r`n"
        $result += "Visible built-client window captured: $($bitmap.Width)x$($bitmap.Height), sampled colours: $($colors.Count).`r`n"
        if ($colors.Count -lt 8) {
            $result += "INCONCLUSIVE: image is near-uniform. Could be blank application content OR hardware WebView2/CI capture limitation. Inspect PNG; do not claim a rendered login screen.`r`n"
            Write-Warning 'Native window capture is near-uniform; visual verification remains inconclusive.'
        }
        $result += "Only the launched application's own HWND was captured with PrintWindow (no desktop pixels).`r`nNo credentials entered. Does not establish login, token storage, video, install/upgrade or Windows 10 compatibility.`r`nCI render capture requires human inspection before release.`r`n"
        [IO.File]::WriteAllText($reportPath, $result)
        Write-Host $result
    } finally { $bitmap.Dispose() }
    if (!$ready) { throw $startupFailure }
} catch {
    [IO.File]::WriteAllText($reportPath, "FAILED/UNVERIFIED: $($_.Exception.Message)`r`nNo successful native-render claim can be made. No desktop fallback was attempted.`r`n")
    throw
} finally {
    if ($null -ne $process) {
        try {
            $process.Refresh()
            if (!$process.HasExited) {
                [void]$process.CloseMainWindow()
                if (!$process.WaitForExit(5000)) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
            }
        } finally { $process.Dispose() }
    }
}
