// SPDX-License-Identifier: GPL-2.0-only
// AnixArtix installer shell. Installation is performed by the unmodified Tauri NSIS payload.
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Reflection;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;

internal static class Setup
{
    internal static Stream Resource(string name)
    {
        Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(name);
        if (stream == null) throw new InvalidDataException("Missing setup resource: " + name);
        return stream;
    }
    internal static string TextResource(string name)
    { using (var reader = new StreamReader(Resource(name), Encoding.UTF8)) return reader.ReadToEnd(); }

    [STAThread]
    private static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        // Preview never extracts or executes the embedded installer.
        bool preview = args.Length == 1 && args[0] == "--preview";
        if (args.Length != 0 && !preview) return 2;
        using (var form = new SetupForm(preview)) { Application.Run(form); return form.Result; }
    }
}

internal sealed class AnimatedMascot : Control
{
    private readonly Stream stream;
    private readonly Image animation;
    private readonly ImageAttributes colors = new ImageAttributes();
    private readonly EventHandler nextFrame;
    internal AnimatedMascot()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);
        stream = Setup.Resource("install-anim.gif");
        animation = Image.FromStream(stream);
        // Remove only the original GIF's green-screen colour at render time; all 239 frames are retained.
        colors.SetColorKey(Color.FromArgb(0, 255, 0), Color.FromArgb(0, 255, 0));
        nextFrame = delegate { if (IsHandleCreated && !IsDisposed) { try { BeginInvoke((Action)delegate { Invalidate(); }); } catch (InvalidOperationException) { } } };
        ImageAnimator.Animate(animation, nextFrame);
    }
    protected override void OnPaint(PaintEventArgs e)
    {
        ImageAnimator.UpdateFrames(animation);
        e.Graphics.DrawImage(animation, ClientRectangle, 0, 0, animation.Width, animation.Height, GraphicsUnit.Pixel, colors);
    }
    protected override void Dispose(bool disposing)
    {
        if (disposing) { ImageAnimator.StopAnimate(animation, nextFrame); animation.Dispose(); stream.Dispose(); colors.Dispose(); }
        base.Dispose(disposing);
    }
}

internal sealed class SetupForm : Form
{
    private readonly Label status;
    private readonly Button install;
    private readonly ProgressBar progress;
    private readonly CheckBox consent;
    private bool installing;
    private bool finished;
    internal int Result = 1;
    private static readonly Color Background = Color.FromArgb(16, 17, 22);
    private static readonly Color Muted = Color.FromArgb(164, 168, 186);
    internal SetupForm(bool preview)
    {
        Text = "AnixArtix — Setup";
        ClientSize = new Size(760, 460);
        AutoScaleDimensions = new SizeF(96F, 96F);
        AutoScaleMode = AutoScaleMode.Dpi;
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Background;
        ForeColor = Color.White;
        Font = new Font("Segoe UI", 10);
        using (var s = Setup.Resource("app.ico")) Icon = new Icon(s);
        Controls.Add(new AnimatedMascot { Location = new Point(24, 90), Size = new Size(300, 300), BackColor = Background, AccessibleName = "Анимированный персонаж AnixArtix" });
        AddLabel("ANIXARTIX  /  WINDOWS", 350, 40, 370, 24, 9, Muted);
        AddLabel("Твоя следующая\nаниме-история", 350, 83, 380, 100, 25, Color.White);
        AddLabel("Установим AnixArtix для твоей учётной записи.\nWindows 10 / 11 · x64 · без прав администратора", 350, 195, 380, 52, 10, Muted);
        var license = new LinkLabel { Text = "Лицензия GPL-2.0 и авторы", Location = new Point(350, 258), AutoSize = true, LinkColor = Color.FromArgb(178, 164, 255), ActiveLinkColor = Color.White };
        license.LinkClicked += delegate { ShowLicense(); };
        Controls.Add(license);
        consent = new CheckBox { Text = "Я ознакомился(ась) с лицензией", Location = new Point(350, 288), Size = new Size(380, 30), BackColor = Background };
        Controls.Add(consent);
        status = AddLabel(preview ? "Предпросмотр — установка отключена" : "Готово к установке. Может понадобиться интернет для WebView2.", 350, 330, 380, 45, 9, Muted);
        progress = new ProgressBar { Location = new Point(350, 382), Size = new Size(370, 4), Style = ProgressBarStyle.Marquee, Visible = false };
        Controls.Add(progress);
        install = new Button { Text = "Установить AnixArtix", Location = new Point(350, 398), Size = new Size(370, 42), FlatStyle = FlatStyle.Flat, BackColor = Color.FromArgb(174, 154, 255), ForeColor = Background, Enabled = false };
        install.FlatAppearance.BorderSize = 0;
        install.Click += async delegate { if (finished) Close(); else await Install(); };
        consent.CheckedChanged += delegate { install.Enabled = consent.Checked && !preview && !installing; };
        Controls.Add(install);
        AcceptButton = install;
        FormClosing += delegate(object sender, FormClosingEventArgs e) { if (installing) { e.Cancel = true; status.Text = "Установка ещё идёт. Подождите завершения, чтобы не повредить файлы."; } };
    }
    private Label AddLabel(string text, int x, int y, int width, int height, float size, Color color)
    {
        var label = new Label { Text = text, Location = new Point(x,y), Size = new Size(width,height), Font = new Font("Segoe UI", size), ForeColor = color };
        Controls.Add(label); return label;
    }
    private void ShowLicense()
    {
        using (var dialog = new Form { Text = "AnixArtix — GPL-2.0 / Attribution", Size = new Size(700, 580), StartPosition = FormStartPosition.CenterParent })
        {
            dialog.Controls.Add(new TextBox { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Dock = DockStyle.Fill, Font = new Font("Consolas", 10), Text = (Setup.TextResource("FORK-NOTICE.md") + "\n\n" + Setup.TextResource("LICENSE")).Replace("\n", "\r\n") });
            dialog.ShowDialog(this);
        }
    }
    private async Task Install()
    {
        installing = true; install.Enabled = false; consent.Enabled = false; progress.Visible = true;
        status.Text = "Устанавливаем… Если нужен WebView2, его загрузит установщик Microsoft.";
        try
        {
            int code = await Task.Run((Func<int>)RunPayload);
            Result = code;
            if (code == 0 || code == 3010 || code == 1641)
            {
                finished = true;
                status.Text = code == 0 ? "Готово! Открой AnixArtix через меню «Пуск» или ярлык." : "Установка завершена. Перезагрузите Windows перед запуском.";
                install.Text = "Готово";
            }
            else { status.Text = "Установка не завершена (код " + code + "). Закрой AnixArtix, проверь интернет и попробуй снова."; install.Text = "Повторить установку"; }
        }
        catch (Exception e)
        {
            Result = 1; status.Text = "Не удалось установить. Можно повторить попытку.";
            MessageBox.Show(this, e.Message, "AnixArtix — ошибка установки", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally { installing = false; progress.Visible = false; consent.Enabled = !finished; install.Enabled = true; }
    }
    private static int RunPayload()
    {
        string directory = Path.Combine(Path.GetTempPath(), "AnixArtix-" + Guid.NewGuid().ToString("N"));
        // Atomically create with protected ACL, not a predictable shared temp filename.
        var permissions = new DirectorySecurity();
        permissions.SetAccessRuleProtection(true, false);
        permissions.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        permissions.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        Directory.CreateDirectory(directory, permissions);
        try
        {
            string payload = Path.Combine(directory, "install.exe");
            using (var source = Setup.Resource("payload.exe"))
            using (var target = new FileStream(payload, FileMode.CreateNew, FileAccess.Write, FileShare.None)) source.CopyTo(target);
            // Hold a read-only share open through process launch/lifetime, preventing replacement after verification.
            using (var file = new FileStream(payload, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (var sha = SHA256.Create())
            {
                string actual = BitConverter.ToString(sha.ComputeHash(file)).Replace("-", "");
                if (!String.Equals(actual, Setup.TextResource("payload.sha256").Trim(), StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Installer integrity check failed.");
                var start = new ProcessStartInfo(payload, "/S") { UseShellExecute = false, WorkingDirectory = directory };
                using (var process = Process.Start(start)) { process.WaitForExit(); return process.ExitCode; }
            }
        }
        finally { try { Directory.Delete(directory, true); } catch (IOException) { } catch (UnauthorizedAccessException) { } }
    }
}
