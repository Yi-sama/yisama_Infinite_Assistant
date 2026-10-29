using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace Yisama
{
    public sealed class GroupOption
    {
        public string value { get; set; }
        public string label { get; set; }
        public override string ToString() { return label ?? value ?? ""; }
    }

    public sealed class AccountState
    {
        public bool loggedIn { get; set; }
        public bool configured { get; set; }
        public string username { get; set; }
        public string quota { get; set; }
        public string group { get; set; }
        public string groupLabel { get; set; }
        public GroupOption[] groups { get; set; }
        public string model { get; set; }
        public string[] models { get; set; }
        public string message { get; set; }
        public bool restartRequired { get; set; }
    }

    internal sealed class BridgeReply
    {
        public int id { get; set; }
        public bool ok { get; set; }
        public AccountState data { get; set; }
        public string error { get; set; }
    }

    internal sealed class DesktopBridge : IDisposable
    {
        private readonly string root;
        private readonly JavaScriptSerializer json = new JavaScriptSerializer();
        private Process worker;
        private int sequence;

        internal DesktopBridge(string appRoot) { root = appRoot; }

        internal async Task<AccountState> Request(string action, string group, string model)
        {
            if (worker == null || worker.HasExited)
            {
                if (worker != null) worker.Dispose();
                string node = Path.Combine(root, "runtime", "node.exe");
                string script = Path.Combine(root, "scripts", "desktop-bridge.mjs");
                if (!File.Exists(node) || !File.Exists(script))
                    throw new InvalidOperationException("安装文件不完整，请重新运行安装器。");
                var start = new ProcessStartInfo(node, "\"" + script + "\"");
                start.WorkingDirectory = root;
                start.UseShellExecute = false;
                start.CreateNoWindow = true;
                start.RedirectStandardInput = true;
                start.RedirectStandardOutput = true;
                start.RedirectStandardError = true;
                start.StandardOutputEncoding = Encoding.UTF8;
                start.StandardErrorEncoding = Encoding.UTF8;
                start.EnvironmentVariables["NODE_TLS_REJECT_UNAUTHORIZED"] = "1";
                worker = Process.Start(start);
                worker.ErrorDataReceived += delegate { };
                worker.BeginErrorReadLine();
                worker.StandardInput.AutoFlush = true;
            }
            int id = ++sequence;
            var request = new Dictionary<string, object> { { "id", id }, { "action", action } };
            if (group != null) request.Add("group", group);
            if (model != null) request.Add("model", model);
            await worker.StandardInput.WriteLineAsync(json.Serialize(request));
            string line = await worker.StandardOutput.ReadLineAsync();
            if (line == null || line.Length > 1024 * 1024)
                throw new InvalidOperationException("连接已断开，请重新打开面板。");
            var reply = json.Deserialize<BridgeReply>(line);
            if (reply == null || reply.id != id)
                throw new InvalidOperationException("连接未完成，请重新打开面板。");
            if (!reply.ok) throw new InvalidOperationException(reply.error ?? "操作未完成，请稍后重试。");
            if (reply.data == null) throw new InvalidOperationException("暂时无法读取账号信息。");
            return reply.data;
        }

        public void Dispose()
        {
            if (worker == null) return;
            try
            {
                if (!worker.HasExited)
                {
                    worker.StandardInput.Close();
                    if (!worker.WaitForExit(2000)) worker.Kill();
                }
            }
            catch (InvalidOperationException) { }
            finally { worker.Dispose(); worker = null; }
        }
    }

    public sealed class AssistantPanel : Form
    {
        private static readonly Color Ink = Color.FromArgb(30, 36, 35);
        private static readonly Color Muted = Color.FromArgb(100, 110, 108);
        private static readonly Color Accent = Color.FromArgb(20, 115, 99);
        private static readonly Color Line = Color.FromArgb(228, 233, 231);
        private readonly bool preview;
        private readonly DesktopBridge bridge;
        private readonly Label connection;
        private readonly Label message;
        private readonly Label username;
        private readonly Label quota;
        private readonly Panel loginView;
        private readonly Panel accountView;
        private readonly Button login;
        private readonly Button recharge;
        private readonly Button refresh;
        private readonly ComboBox groups;
        private readonly ComboBox models;
        private readonly ContextMenuStrip menu;
        private AccountState state = new AccountState();
        private bool updating;
        private bool busy;
        private bool forceRefresh;

        public bool Busy { get { return busy; } }
        public bool AllowExit { get; set; }

        [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
        private static extern IntPtr SetOwner64(IntPtr window, int index, IntPtr value);
        [DllImport("user32.dll", EntryPoint = "SetWindowLongW")]
        private static extern IntPtr SetOwner32(IntPtr window, int index, IntPtr value);

        public AssistantPanel(string appRoot, bool isPreview)
        {
            preview = isPreview;
            bridge = new DesktopBridge(appRoot);
            Text = "yisama 无限助手" + (preview ? " · 预览" : "");
            Name = "YisamaAccountPanel";
            Font = new Font("Microsoft YaHei UI", 9F);
            ForeColor = Ink;
            BackColor = Color.White;
            AutoScaleMode = AutoScaleMode.Dpi;
            AutoScaleDimensions = new SizeF(96, 96);
            ClientSize = new Size(368, 552);
            FormBorderStyle = FormBorderStyle.FixedToolWindow;
            MaximizeBox = false;
            MinimizeBox = false;
            ShowInTaskbar = preview;
            StartPosition = FormStartPosition.CenterScreen;
            KeyPreview = true;

            var root = new TableLayoutPanel();
            root.Dock = DockStyle.Fill;
            root.Padding = new Padding(22, 16, 22, 12);
            root.ColumnCount = 1;
            root.RowCount = 5;
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 58));
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 1));
            root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 54));
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 22));
            Controls.Add(root);

            var header = new Panel { Dock = DockStyle.Fill };
            var mark = TextLabel("\u221e", 22F, Accent);
            mark.Font = new Font("Segoe UI Symbol", 21F, FontStyle.Regular);
            mark.TextAlign = ContentAlignment.MiddleCenter;
            mark.SetBounds(0, 0, 38, 48);
            header.Controls.Add(mark);
            var title = TextLabel("yisama 无限助手", 11F, Ink);
            title.Font = new Font("Microsoft YaHei UI", 11F, FontStyle.Bold);
            title.SetBounds(46, 1, 222, 25);
            header.Controls.Add(title);
            connection = TextLabel(preview ? "界面预览" : "未登录", 8.5F, Muted);
            connection.SetBounds(46, 28, 224, 20);
            header.Controls.Add(connection);
            menu = new ContextMenuStrip();
            menu.Items.Add("重新连接账号", null, async delegate { await Execute("login", null, null); });
            menu.Items.Add("恢复原配置并退出账号", null, async delegate
            {
                if (MessageBox.Show(this, "恢复原来的 Codex 配置并退出 yisama 账号？\n之后添加的个人设置将保留。",
                    "恢复原配置", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) == DialogResult.OK)
                    await Execute("restore", null, null);
            });
            var more = IconButton("\uE712", "账号选项");
            more.SetBounds(284, 0, 32, 32);
            more.Click += delegate { menu.Show(more, new Point(0, more.Height)); };
            header.Controls.Add(more);
            root.Controls.Add(header, 0, 0);
            root.Controls.Add(new Panel { Dock = DockStyle.Fill, BackColor = Line }, 0, 1);

            var content = new Panel { Dock = DockStyle.Fill, AutoScroll = true };
            root.Controls.Add(content, 0, 2);
            loginView = new Panel { Dock = DockStyle.Fill };
            var loginTitle = TextLabel("登录 yisama", 17F, Ink);
            loginTitle.SetBounds(0, 42, 310, 34);
            loginView.Controls.Add(loginTitle);
            var sharedAccount = TextLabel("与官方中转站账号互通", 10F, Muted);
            sharedAccount.SetBounds(0, 91, 314, 26);
            loginView.Controls.Add(sharedAccount);
            var site = TextLabel("https://api.yisama.asia", 9F, Muted);
            site.SetBounds(0, 123, 314, 26);
            loginView.Controls.Add(site);
            login = CommandButton("使用中转站账号登录", true);
            login.SetBounds(0, 185, 314, 44);
            login.Click += async delegate { await Execute("login", null, null); };
            loginView.Controls.Add(login);
            content.Controls.Add(loginView);

            accountView = new Panel { Dock = DockStyle.Fill };
            username = TextLabel("", 9.5F, Ink);
            username.SetBounds(0, 19, 252, 26);
            accountView.Controls.Add(username);
            refresh = IconButton("\uE72C", "刷新余额");
            refresh.SetBounds(282, 15, 32, 32);
            refresh.Click += delegate { RefreshAccount(); };
            accountView.Controls.Add(refresh);
            var walletLabel = TextLabel("剩余额度", 9F, Muted);
            walletLabel.SetBounds(0, 61, 210, 25);
            accountView.Controls.Add(walletLabel);
            quota = TextLabel("", 26F, Ink);
            quota.Font = new Font("Segoe UI", 26F, FontStyle.Regular);
            quota.SetBounds(0, 89, 310, 52);
            accountView.Controls.Add(quota);
            var groupLabel = TextLabel("分组", 9F, Muted);
            groupLabel.SetBounds(0, 164, 92, 24);
            accountView.Controls.Add(groupLabel);
            groups = Selector("分组");
            groups.SetBounds(0, 191, 314, 30);
            groups.SelectionChangeCommitted += async delegate
            {
                var item = groups.SelectedItem as GroupOption;
                if (!updating && item != null) await Execute("select", item.value, null);
            };
            accountView.Controls.Add(groups);
            var modelLabel = TextLabel("模型", 9F, Muted);
            modelLabel.SetBounds(0, 238, 92, 24);
            accountView.Controls.Add(modelLabel);
            models = Selector("模型");
            models.SetBounds(0, 265, 314, 30);
            models.SelectionChangeCommitted += async delegate
            {
                if (!updating && models.SelectedItem != null)
                    await Execute("select", state.group, models.SelectedItem.ToString());
            };
            accountView.Controls.Add(models);
            recharge = CommandButton("自定义充值", false);
            recharge.SetBounds(0, 315, 314, 38);
            recharge.Click += async delegate { await Execute("recharge", null, null); };
            accountView.Controls.Add(recharge);
            content.Controls.Add(accountView);
            accountView.Hide();

            message = TextLabel("", 8.5F, Muted);
            message.Dock = DockStyle.Fill;
            message.Padding = new Padding(0, 7, 0, 0);
            message.AutoEllipsis = false;
            root.Controls.Add(message, 0, 3);
            var fee = TextLabel("优先线路按 1.5x 计费", 8F, Muted);
            fee.Dock = DockStyle.Fill;
            root.Controls.Add(fee, 0, 4);

            Shown += delegate { if (!preview) RefreshAccount(); };
            KeyDown += delegate(object sender, KeyEventArgs e)
            {
                if (e.KeyCode == Keys.Escape) { Hide(); e.Handled = true; }
            };
            FormClosing += delegate(object sender, FormClosingEventArgs e)
            {
                if (AllowExit) return;
                e.Cancel = true;
                Hide();
            };
            Apply(new AccountState());
        }

        private static Label TextLabel(string text, float size, Color color)
        {
            return new Label { Text = text, ForeColor = color,
                Font = new Font("Microsoft YaHei UI", size), AutoSize = false, AutoEllipsis = true };
        }

        private static Button CommandButton(string text, bool primary)
        {
            var button = new Button { Text = text, FlatStyle = FlatStyle.Flat, Cursor = Cursors.Hand,
                BackColor = primary ? Accent : Color.White, ForeColor = primary ? Color.White : Ink,
                UseVisualStyleBackColor = false };
            button.FlatAppearance.BorderColor = primary ? Accent : Line;
            button.FlatAppearance.BorderSize = primary ? 0 : 1;
            return button;
        }

        private static Button IconButton(string symbol, string label)
        {
            var button = new Button { Text = symbol, Font = new Font("Segoe MDL2 Assets", 11F),
                FlatStyle = FlatStyle.Flat, Cursor = Cursors.Hand, AccessibleName = label,
                BackColor = Color.White, ForeColor = Muted, UseVisualStyleBackColor = false };
            button.FlatAppearance.BorderSize = 0;
            var tip = new ToolTip();
            tip.SetToolTip(button, label);
            button.Disposed += delegate { tip.Dispose(); };
            return button;
        }

        private static ComboBox Selector(string label)
        {
            var selector = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList,
                AccessibleName = label, MaxDropDownItems = 8, IntegralHeight = false,
                DropDownHeight = 216, AutoCompleteSource = AutoCompleteSource.ListItems,
                AutoCompleteMode = AutoCompleteMode.SuggestAppend, DrawMode = DrawMode.OwnerDrawFixed,
                ItemHeight = 24 };
            selector.DrawItem += delegate(object sender, DrawItemEventArgs e)
            {
                e.DrawBackground();
                if (e.Index >= 0)
                {
                    TextRenderer.DrawText(e.Graphics, selector.Items[e.Index].ToString(), selector.Font,
                        new Rectangle(e.Bounds.X + 6, e.Bounds.Y, e.Bounds.Width - 8, e.Bounds.Height),
                        e.ForeColor, TextFormatFlags.Left | TextFormatFlags.VerticalCenter |
                        TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
                }
                e.DrawFocusRectangle();
            };
            return selector;
        }

        public void SetHostWindow(IntPtr owner)
        {
            if (IntPtr.Size == 8) SetOwner64(Handle, -8, owner);
            else SetOwner32(Handle, -8, owner);
        }

        public async void RefreshAccount()
        {
            if (!busy) await Execute("status", null, null);
            else forceRefresh = true;
        }

        private async Task Execute(string action, string group, string model)
        {
            if (busy) return;
            busy = true;
            EnableActions(false);
            message.ForeColor = Muted;
            message.Text = action == "login" ? "请在打开的官方页面完成登录。" : "正在连接…";
            try
            {
                if (preview)
                {
                    await Task.Delay(120);
                    if (action == "login") Apply(DemoAccount());
                    else if (action == "restore") Apply(new AccountState());
                    else if (action == "select")
                    {
                        state.group = group ?? state.group;
                        state.groupLabel = state.group == "auto" ? "All" : state.group;
                        state.model = model ?? state.model;
                        state.restartRequired = true;
                        state.message = "配置已保存，重新打开 Codex 后使用。";
                        Apply(state);
                    }
                    else if (action == "recharge") message.Text = "预览不会打开真实充值页面。";
                    else Apply(state);
                }
                else Apply(await bridge.Request(action, group, model));
            }
            catch (InvalidOperationException error)
            {
                message.ForeColor = Color.FromArgb(171, 55, 55);
                message.Text = error.Message;
            }
            catch (Exception)
            {
                message.ForeColor = Color.FromArgb(171, 55, 55);
                message.Text = "操作未完成，请检查网络后重试。";
            }
            finally
            {
                busy = false;
                EnableActions(true);
                if (forceRefresh && Visible) { forceRefresh = false; RefreshAccount(); }
            }
        }

        private void EnableActions(bool enabled)
        {
            login.Enabled = enabled;
            recharge.Enabled = enabled;
            refresh.Enabled = enabled;
            groups.Enabled = enabled && state.loggedIn;
            models.Enabled = enabled && state.loggedIn;
            menu.Enabled = enabled;
        }

        private void Apply(AccountState next)
        {
            state = next;
            updating = true;
            try
            {
                bool authenticated = state.loggedIn;
                loginView.Visible = !authenticated || !state.configured;
                accountView.Visible = authenticated && state.configured;
                login.Text = authenticated && !state.configured ? "完成 Codex 设置" : "使用中转站账号登录";
                connection.Text = preview ? "界面预览" :
                    authenticated ? state.configured ? "账号已连接" : "等待完成设置" : "未登录";
                connection.ForeColor = authenticated ? Accent : Muted;
                username.Text = state.username ?? "";
                quota.Text = state.quota ?? "暂时无法读取";
                groups.Items.Clear();
                foreach (var item in state.groups ?? new GroupOption[0])
                {
                    groups.Items.Add(item);
                    if (item.value == state.group) groups.SelectedItem = item;
                }
                models.Items.Clear();
                foreach (var model in state.models ?? new string[0])
                {
                    models.Items.Add(model);
                    if (model == state.model) models.SelectedItem = model;
                }
                message.ForeColor = state.restartRequired ? Color.FromArgb(136, 92, 28) : Muted;
                message.Text = state.message ?? "";
            }
            finally { updating = false; }
        }

        private static AccountState DemoAccount()
        {
            return new AccountState { loggedIn = true, configured = true, username = "Yisama",
                quota = "$12.50", group = "auto", groupLabel = "All", model = "gpt-5.6-sol",
                groups = new[] { new GroupOption { value = "auto", label = "All" },
                    new GroupOption { value = "premium", label = "Premium" } },
                models = new[] { "gpt-5.6-sol", "gpt-5.5" }, message = "" };
        }

        private static void Check(bool value, string description)
        {
            if (!value) throw new InvalidOperationException(description);
        }

        private static void CheckBounds(Control parent)
        {
            foreach (Control child in parent.Controls)
            {
                if (!child.Visible) continue;
                Check(child.Left >= 0 && child.Top >= 0 &&
                    child.Right <= parent.ClientSize.Width + 1 &&
                    child.Bottom <= parent.ClientSize.Height + 1, "Control overflow: " + child.Name + "/" + child.Text);
                CheckBounds(child);
            }
        }

        private void CaptureScreenshot(string path)
        {
            using (var image = new Bitmap(Width, Height))
            {
                DrawToBitmap(image, new Rectangle(0, 0, Width, Height));
                image.Save(path, ImageFormat.Png);
            }
        }

        public static int RunSelfTest(string outputDirectory)
        {
            Directory.CreateDirectory(outputDirectory);
            using (var panel = new AssistantPanel(AppDomain.CurrentDomain.BaseDirectory, true))
            {
                panel.AllowExit = true;
                panel.Show();
                Application.DoEvents();
                Check(panel.loginView.Visible && !panel.accountView.Visible, "Initial login view");
                CheckBounds(panel);
                panel.CaptureScreenshot(Path.Combine(outputDirectory, "panel-login.png"));
                panel.Apply(DemoAccount());
                Application.DoEvents();
                Check(panel.accountView.Visible && !panel.loginView.Visible, "Account view");
                Check(panel.groups.Items.Count == 2 && panel.models.Items.Count == 2, "Selectors populated");
                Check(panel.groups.SelectedItem.ToString() == "All", "All selected");
                CheckBounds(panel);
                panel.CaptureScreenshot(Path.Combine(outputDirectory, "panel-account.png"));
                var longAccount = DemoAccount();
                longAccount.username = new string('W', 120);
                longAccount.quota = "$123,456,789.00";
                longAccount.restartRequired = true;
                longAccount.message = "配置已保存，重新打开 Codex 后使用。";
                panel.Apply(longAccount);
                panel.Scale(new SizeF(1.5F, 1.5F));
                Application.DoEvents();
                CheckBounds(panel);
                panel.CaptureScreenshot(Path.Combine(outputDirectory, "panel-account-150.png"));
                var allText = new StringBuilder();
                AppendText(panel, allText);
                Check(!allText.ToString().Contains("API Key") && !allText.ToString().Contains("Endpoint") &&
                    !allText.ToString().Contains("Fast") && !allText.ToString().Contains("Ultra"),
                    "No technical configuration controls");
                panel.AllowExit = false;
                panel.Close();
                Check(!panel.Visible && !panel.IsDisposed, "Closing hides, does not exit");
                panel.AllowExit = true;
                panel.Close();
            }
            File.WriteAllText(Path.Combine(outputDirectory, "panel-tests.json"),
                "{\"passed\":true,\"checks\":[\"login\",\"account\",\"selectors\",\"overflow\",\"150-percent\",\"hidden-settings\",\"close-hides\"]}",
                new UTF8Encoding(false));
            return 0;
        }

        private static void AppendText(Control parent, StringBuilder text)
        {
            if (!parent.Visible) return;
            text.AppendLine(parent.Text);
            foreach (Control child in parent.Controls) AppendText(child, text);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) { bridge.Dispose(); menu.Dispose(); }
            base.Dispose(disposing);
        }
    }
}
