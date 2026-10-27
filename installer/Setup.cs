// SPDX-License-Identifier: GPL-2.0-only
// AnixArtix installer shell. Installation is performed by the unmodified Tauri NSIS payload.
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Drawing.Drawing2D;
using System.IO;
using System.Reflection;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
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
        using (var mutex = new Mutex(false, @"Local\AnixArtix.Setup." + WindowsIdentity.GetCurrent().User.Value))
        {
            bool ownsMutex;
            try { ownsMutex = mutex.WaitOne(0); } catch (AbandonedMutexException) { ownsMutex = true; }
            if (!ownsMutex) { MessageBox.Show("Установщик AnixArtix уже открыт.", "AnixArtix"); return 1618; }
            try { using (var form = new SetupForm(preview)) { Application.Run(form); return form.Result; } }
            finally { mutex.ReleaseMutex(); }
        }
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

// Owner-drawn controls retain native button/checkbox keyboard and accessibility semantics.
internal sealed class SetupButton : Button
{
    internal SetupButton()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
        FlatStyle = FlatStyle.Flat;
        FlatAppearance.BorderSize = 0;
        Cursor = Cursors.Hand;
    }
    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        var bounds = new Rectangle(1, 1, Width - 3, Height - 3);
        int r = Math.Max(6, Height / 5);
        using (var shape = new GraphicsPath())
        {
            shape.AddArc(bounds.Left, bounds.Top, r, r, 180, 90);
            shape.AddArc(bounds.Right - r, bounds.Top, r, r, 270, 90);
            shape.AddArc(bounds.Right - r, bounds.Bottom - r, r, r, 0, 90);
            shape.AddArc(bounds.Left, bounds.Bottom - r, r, r, 90, 90);
            shape.CloseFigure();
            Color fill = Enabled ? BackColor : Color.FromArgb(49, 49, 56);
            if (Enabled && ClientRectangle.Contains(PointToClient(System.Windows.Forms.Cursor.Position))) fill = ControlPaint.Light(fill, .12F);
            using (var brush = new SolidBrush(fill)) e.Graphics.FillPath(brush, shape);
            if (Focused && ShowFocusCues) using (var pen = new Pen(Color.White, 2)) e.Graphics.DrawPath(pen, shape);
        }
        TextRenderer.DrawText(e.Graphics, Text, Font, ClientRectangle, Enabled ? ForeColor : Color.FromArgb(145, 145, 155), TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
    }
    protected override void OnMouseEnter(EventArgs e) { base.OnMouseEnter(e); Invalidate(); }
    protected override void OnMouseLeave(EventArgs e) { base.OnMouseLeave(e); Invalidate(); }
}

internal sealed class ConsentCheckBox : CheckBox
{
    internal ConsentCheckBox()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
        Cursor = Cursors.Hand;
    }
    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.Clear(BackColor);
        int side = Math.Max(16, Font.Height);
        var box = new Rectangle(1, (Height - side) / 2, side, side);
        Color accent = Enabled ? Color.FromArgb(235, 75, 87) : Color.FromArgb(108, 108, 120);
        using (var brush = new SolidBrush(Checked ? accent : Color.FromArgb(34, 34, 41))) e.Graphics.FillRectangle(brush, box);
        using (var pen = new Pen(Checked ? accent : Color.FromArgb(106, 106, 120))) e.Graphics.DrawRectangle(pen, box);
        if (Checked)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (var pen = new Pen(Color.White, 2)) e.Graphics.DrawLines(pen, new Point[] { new Point(box.Left + side / 4, box.Top + side / 2), new Point(box.Left + side * 2 / 5, box.Top + side * 3 / 4), new Point(box.Left + side * 4 / 5, box.Top + side / 4) });
        }
        var textBounds = new Rectangle(side + 12, 0, Width - side - 12, Height);
        TextRenderer.DrawText(e.Graphics, Text, Font, textBounds, Enabled ? ForeColor : Color.FromArgb(130, 130, 143), TextFormatFlags.Left | TextFormatFlags.VerticalCenter);
        if (Focused && ShowFocusCues) ControlPaint.DrawFocusRectangle(e.Graphics, textBounds, ForeColor, BackColor);
    }
}

internal sealed class ActivityLine : Control
{
    private readonly System.Windows.Forms.Timer timer;
    private int offset;
    internal ActivityLine()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
        timer = new System.Windows.Forms.Timer { Interval = 30 };
        timer.Tick += delegate { offset = (offset + 8) % Math.Max(1, Width + Width / 3); Invalidate(); };
        AccessibleName = "Установка выполняется";
        AccessibleRole = AccessibleRole.ProgressBar;
        TabStop = false;
    }
    protected override void OnVisibleChanged(EventArgs e) { base.OnVisibleChanged(e); if (timer != null) timer.Enabled = Visible; }
    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.Clear(Color.FromArgb(49, 49, 56));
        using (var brush = new SolidBrush(Color.FromArgb(235, 75, 87))) e.Graphics.FillRectangle(brush, offset - Width / 3, 0, Width / 3, Height);
    }
    protected override void Dispose(bool disposing) { if (disposing) timer.Dispose(); base.Dispose(disposing); }
}

internal sealed class SetupForm : Form
{
    private readonly Label status;
    private readonly Label heading;
    private readonly Button install;
    private readonly Button close;
    private readonly ActivityLine progress;
    private readonly CheckBox consent;
    private bool installing;
    private bool finished;
    private Point dragOrigin;
    internal int Result = 1;
    private static readonly Color Background = Color.FromArgb(24, 24, 29);
    private static readonly Color Muted = Color.FromArgb(165, 165, 179);
    private static readonly Color Accent = Color.FromArgb(235, 75, 87);
    internal SetupForm(bool preview)
    {
        Text = "AnixArtix — Setup";
        AutoScaleDimensions = new SizeF(96F, 96F);
        AutoScaleMode = AutoScaleMode.Dpi;
        ClientSize = new Size(780, 480);
        FormBorderStyle = FormBorderStyle.None;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Background;
        ForeColor = Color.FromArgb(244, 244, 248);
        Font = new Font("Segoe UI", 10);
        DoubleBuffered = true;
        using (var s = Setup.Resource("app.ico")) Icon = new Icon(s);
        var title = AddLabel("ANIXARTIX", 24, 18, 150, 26, 10, ForeColor);
        title.Font = new Font("Segoe UI", 10, FontStyle.Bold);
        var titleHint = AddLabel("Установка для Windows", 164, 19, 490, 25, 9, Muted);
        EnableDrag(this); EnableDrag(title); EnableDrag(titleHint);
        close = new SetupButton { Text = "×", AccessibleName = "Закрыть установщик", Location = new Point(718, 10), Size = new Size(44, 36), BackColor = Background, ForeColor = Muted, Font = new Font("Segoe UI", 17), TabIndex = 3 };
        close.Click += delegate { Close(); };
        Controls.Add(close);
        var rule = new Panel { Location = new Point(24, 58), Size = new Size(732, 1), BackColor = Color.FromArgb(49, 49, 58) };
        Controls.Add(rule);
        Controls.Add(new AnimatedMascot { Location = new Point(22, 102), Size = new Size(300, 300), BackColor = Background, AccessibleName = "Анимированный персонаж AnixArtix", TabStop = false });
        AddLabel("АНИМЕ В ТВОЁМ РИТМЕ", 36, 418, 270, 24, 9, Muted).TextAlign = ContentAlignment.MiddleCenter;
        AddLabel("ANIXARTIX  /  WINDOWS x64", 350, 84, 400, 24, 9, Accent);
        heading = AddLabel("Установка AnixArtix", 348, 119, 408, 44, 23, ForeColor);
        heading.Font = new Font("Segoe UI", 23, FontStyle.Bold);
        AddLabel("Всё для просмотра — в одном приложении.", 350, 169, 400, 26, 10, Muted);
        AddLabel("Только для вашей учётной записи.\nWindows 10 / 11 · без прав администратора", 350, 212, 400, 48, 10, Muted);
        var license = new LinkLabel { Text = "Лицензия GPL-2.0 и авторы", Location = new Point(350, 276), Size = new Size(400, 26), LinkColor = Muted, ActiveLinkColor = Accent, VisitedLinkColor = Muted, LinkBehavior = LinkBehavior.HoverUnderline, TabIndex = 0 };
        license.LinkClicked += delegate { ShowLicense(); };
        Controls.Add(license);
        consent = new ConsentCheckBox { Text = "Я ознакомился(ась) с лицензией", Location = new Point(350, 307), Size = new Size(400, 30), BackColor = Background, ForeColor = ForeColor, TabIndex = 1 };
        Controls.Add(consent);
        status = AddLabel(preview ? "Предпросмотр · установка отключена" : "Может понадобиться интернет для WebView2.", 350, 350, 400, 44, 9, Muted);
        status.AccessibleName = "Состояние установки";
        progress = new ActivityLine { Location = new Point(350, 397), Size = new Size(400, 3), Visible = false };
        Controls.Add(progress);
        install = new SetupButton { Text = "Установить AnixArtix", Location = new Point(350, 412), Size = new Size(400, 44), BackColor = Accent, ForeColor = Color.White, Enabled = false, TabIndex = 2 };
        install.Click += async delegate { if (finished) Close(); else await Install(); };
        consent.CheckedChanged += delegate { install.Enabled = consent.Checked && !preview && !installing; };
        Controls.Add(install);
        AcceptButton = install;
        FormClosing += delegate(object sender, FormClosingEventArgs e) { if (installing) { e.Cancel = true; status.Text = "Установка ещё идёт. Дождитесь её завершения."; } };
    }
    private void EnableDrag(Control control)
    {
        control.MouseDown += delegate(object sender, MouseEventArgs e) { if (e.Button == MouseButtons.Left) dragOrigin = System.Windows.Forms.Cursor.Position; };
        control.MouseMove += delegate(object sender, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left) return;
            Point current = System.Windows.Forms.Cursor.Position;
            Location = new Point(Left + current.X - dragOrigin.X, Top + current.Y - dragOrigin.Y);
            dragOrigin = current;
        };
    }
    protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
    {
        if (keyData == Keys.Escape) { Close(); return true; }
        return base.ProcessCmdKey(ref msg, keyData);
    }
    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        using (var pen = new Pen(Color.FromArgb(61, 61, 72))) e.Graphics.DrawRectangle(pen, 0, 0, ClientSize.Width - 1, ClientSize.Height - 1);
    }
    private Label AddLabel(string text, int x, int y, int width, int height, float size, Color color)
    {
        var label = new Label { Text = text, Location = new Point(x,y), Size = new Size(width,height), Font = new Font("Segoe UI", size), ForeColor = color };
        Controls.Add(label); return label;
    }
    private void ShowLicense()
    {
        using (var dialog = new Form { Text = "AnixArtix — GPL-2.0 / Attribution", Size = new Size(700, 580), StartPosition = FormStartPosition.CenterParent, BackColor = Background, ForeColor = ForeColor, MinimizeBox = false })
        {
            dialog.Controls.Add(new TextBox { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Dock = DockStyle.Fill, BorderStyle = BorderStyle.None, BackColor = Background, ForeColor = ForeColor, Font = new Font("Segoe UI", 10), Text = (Setup.TextResource("FORK-NOTICE.md") + "\n\n" + Setup.TextResource("LICENSE")).Replace("\n", "\r\n") });
            dialog.ShowDialog(this);
        }
    }
    private async Task Install()
    {
        installing = true; install.Enabled = false; consent.Enabled = false; close.Enabled = false; progress.Visible = true;
        heading.Text = "Устанавливаем…";
        install.Text = "Установка выполняется";
        status.ForeColor = Muted;
        status.Text = "Если нужен WebView2, его загрузит установщик Microsoft. Это может занять несколько минут.";
        try
        {
            int code = await Task.Run((Func<int>)RunPayload);
            Result = code;
            if (code == 0 || code == 3010 || code == 1641)
            {
                finished = true;
                heading.Text = "Всё готово";
                status.Text = code == 0 ? "Откройте AnixArtix через меню «Пуск» или ярлык. Приложение не запускается автоматически." : "Установка завершена. Перезагрузите Windows перед запуском.";
                install.Text = "Закрыть установщик";
            }
            else { heading.Text = "Установка прервана"; status.ForeColor = Accent; status.Text = "Код " + code + ". Закройте AnixArtix, проверьте интернет и повторите попытку."; install.Text = "Повторить установку"; }
        }
        catch (Exception e)
        {
            Result = 1; heading.Text = "Установка прервана"; status.ForeColor = Accent; status.Text = "Можно повторить попытку. Подробности — в сообщении об ошибке."; install.Text = "Повторить установку";
            MessageBox.Show(this, e.Message, "AnixArtix — ошибка установки", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally { installing = false; progress.Visible = false; consent.Enabled = !finished; close.Enabled = true; install.Enabled = true; install.Focus(); }
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
