# Animated Windows setup

A small .NET Framework WinForms shell wraps the **unchanged Tauri-generated NSIS installer**. It uses Windows' built-in .NET Framework / GDI+ (`ImageAnimator`), not a downloaded NSIS plug-in, WebView2 UI, Electron, or another bundled runtime. The original `icon/install-anim.gif` (239 frames) is embedded intact; its pure green background is colour-keyed at paint time. GIF timing remains intact. Build with the Microsoft compiler already installed on Windows.

## Build

1. `npm ci --legacy-peer-deps`
2. `npm run make:windows`
3. `powershell -NoProfile -File installer/test.ps1` (harmless fixture only)
4. `powershell -NoProfile -File installer/build.ps1`

Output: `dist/installer/AnixArtix_<version>_x64-setup.exe` and `.sha256`. The Windows workflow also archives the exact build commit as `AnixArtix-source.zip` and hashes it. Deliver that corresponding GPL source alongside the binary. `--preview` opens the real animated interface with installation disabled. No other command-line arguments are supported by the outer shell; automated deployment can use the inner standard Tauri NSIS bundle instead.

## Behaviour and boundaries

- Windows 10/11 x64; .NET Framework 4.x is an OS component. No setup runtime is downloaded.
- Requires explicit licence acknowledgement and an Install click. GPL text and original fork attribution remain accessible before and after installation.
- Runs the embedded NSIS with `/S`, as the current user, with no custom destination override. NSIS remains responsible for upgrade handling, shortcuts, registry registration, the uninstaller and WebView2 detection/bootstrapper. WebView2 may need internet access and Microsoft UI. Close a running AnixArtix before installing/upgrading.
- The GIF stays animated during extraction/installation. The indeterminate bar does not invent a percentage. Closing is blocked while installation is active; forcibly terminating the installer is not a supported cancellation path.
- Payload is extracted into a unique ACL-protected temp directory, checked against an embedded SHA-256, held read-only during execution, and cleaned up after it exits. Hash is an integrity check, **not** publisher authentication; the setup remains unsigned until code-signing is configured.
- Success, failure and restart-required exit codes are preserved (0, 3010, 1641); no automatic app launch or restart. Failure allows retry. Closing before installing returns 1.
- The GIF adds about 2.7 MB to the normal NSIS size. No static-frame substitution.

## Verification

`test.ps1` compiles both the shell and a harmless child fixture. It verifies the embedded animation, `/S` forwarding, success/failure/restart exit codes, and temp cleanup without installing the application. Actual installation still needs Windows 10 and 11 interactive QA: 100%/150%/200% DPI, GIF playback, licence dialog, fresh install, repeated/upgrade install (including app running), missing WebView2/network failure, retry, close-before-install/close-during-install, shortcut launch and uninstall. Linux checks alone do not establish these results.

Official references: [Tauri Windows installer](https://v2.tauri.app/distribute/windows-installer/), [Microsoft ImageAnimator](https://learn.microsoft.com/en-us/dotnet/api/system.drawing.imageanimator), [colour key](https://learn.microsoft.com/en-us/dotnet/api/system.drawing.imaging.imageattributes.setcolorkey), [.NET/Windows versions](https://learn.microsoft.com/en-us/dotnet/framework/install/versions-and-dependencies).
