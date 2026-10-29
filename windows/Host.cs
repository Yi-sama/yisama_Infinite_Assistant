using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace Yisama
{
    internal static class HostProgram
    {
        internal const string RunValueName = "YisamaInfiniteAssistant";

        [STAThread]
        private static int Main(string[] args)
        {
            NativeWindows.EnablePerMonitorDpiAwareness();
            if (args.Length == 1 && string.Equals(args[0], "--watch", StringComparison.OrdinalIgnoreCase))
            {
                return RunWatcher(0, null);
            }

            if (args.Length == 1 && string.Equals(args[0], "--preview", StringComparison.OrdinalIgnoreCase))
            {
                return RunPreview();
            }

            if (args.Length == 2 && string.Equals(args[0], "--self-test", StringComparison.OrdinalIgnoreCase))
            {
                if (!Path.IsPathRooted(args[1]))
                {
                    Console.Error.WriteLine("--self-test requires an explicit absolute output directory.");
                    return 2;
                }
                try
                {
                    Application.EnableVisualStyles();
                    Application.SetCompatibleTextRenderingDefault(false);
                    return AssistantPanel.RunSelfTest(Path.GetFullPath(args[1]));
                }
                catch (Exception)
                {
                    Console.Error.WriteLine("Self-test failed.");
                    return 1;
                }
            }

            if (args.Length == 4 && string.Equals(args[0], "--test-target", StringComparison.OrdinalIgnoreCase) &&
                string.Equals(args[2], "--test-events", StringComparison.OrdinalIgnoreCase))
            {
                int pid;
                if (!int.TryParse(args[1], out pid) || pid <= 0 || !IsTempFile(args[3]))
                {
                    Console.Error.WriteLine("--test-target requires a process id and --test-events <absolute temp path>.");
                    return 2;
                }
                return RunWatcher(pid, Path.GetFullPath(args[3]));
            }

            if (args.Length == 1 && string.Equals(args[0], "--uninstall", StringComparison.OrdinalIgnoreCase))
            {
                RequestStop();
                RemoveOwnedRunEntry();
                return 0;
            }

            Console.Error.WriteLine("Usage: Host.exe --watch | --preview | --self-test <output-dir> | --uninstall");
            return 2;
        }

        private static bool IsTempFile(string path)
        {
            if (string.IsNullOrEmpty(path) || !Path.IsPathRooted(path)) return false;
            string full = Path.GetFullPath(path);
            string temp = Path.GetFullPath(Path.GetTempPath());
            return full.StartsWith(temp, StringComparison.OrdinalIgnoreCase);
        }

        private static int RunWatcher(int testTargetPid, string eventFile)
        {
            bool created;
            string mutexName = testTargetPid == 0 ? HostNames.MutexName : HostNames.TestMutexName(testTargetPid);
            string stopEventName = testTargetPid == 0 ? HostNames.StopEventName : HostNames.TestStopEventName(testTargetPid);
            using (Mutex mutex = new Mutex(false, mutexName, out created))
            {
                if (!created) return 0;
                using (EventWaitHandle stopEvent = new EventWaitHandle(false, EventResetMode.ManualReset, stopEventName))
                {
                    stopEvent.Reset();
                    Application.EnableVisualStyles();
                    Application.SetCompatibleTextRenderingDefault(false);
                    using (AssistantWatcher watcher = new AssistantWatcher(AppRoot(), stopEvent, testTargetPid, eventFile))
                    {
                        Application.Run(watcher);
                    }
                }
            }
            return 0;
        }

        private static int RunPreview()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using (AssistantPanel panel = new AssistantPanel(AppRoot(), true))
            {
                panel.AllowExit = true;
                panel.StartPosition = FormStartPosition.CenterScreen;
                Application.Run(panel);
            }
            return 0;
        }

        internal static string AppRoot()
        {
            return AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        }

        internal static void RequestStop()
        {
            try
            {
                using (EventWaitHandle stop = EventWaitHandle.OpenExisting(HostNames.StopEventName))
                {
                    stop.Set();
                }
            }
            catch (WaitHandleCannotBeOpenedException)
            {
            }
        }

        internal static void RemoveOwnedRunEntry()
        {
            using (RegistryKey run = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true))
            {
                if (run != null) run.DeleteValue(RunValueName, false);
            }
        }
    }

    internal static class HostNames
    {
        private static readonly string Suffix = CurrentUserSuffix();

        internal static string MutexName { get { return @"Local\YisamaInfiniteAssistant." + Suffix; } }
        internal static string StopEventName { get { return @"Local\YisamaInfiniteAssistant.Stop." + Suffix; } }
        internal static string TestMutexName(int pid) { return MutexName + ".Test." + pid; }
        internal static string TestStopEventName(int pid) { return StopEventName + ".Test." + pid; }

        private static string CurrentUserSuffix()
        {
            WindowsIdentity identity = WindowsIdentity.GetCurrent();
            if (identity != null && identity.User != null) return identity.User.Value.Replace('-', '_');
            return Environment.UserName;
        }
    }

    internal sealed class AssistantWatcher : ApplicationContext, IDisposable
    {
        private readonly string appRoot;
        private readonly EventWaitHandle stopEvent;
        private readonly int testTargetPid;
        private readonly string eventFile;
        private readonly System.Windows.Forms.Timer timer;
        private readonly FloatingButton button;
        private IntPtr ownerWindow;
        private IntPtr lastTestCandidate;
        private bool? lastTestCandidateForeground;
        private AssistantPanel panel;
        private bool disposed;

        internal AssistantWatcher(string appRoot, EventWaitHandle stopEvent, int testTargetPid, string eventFile)
        {
            this.appRoot = appRoot;
            this.stopEvent = stopEvent;
            this.testTargetPid = testTargetPid;
            this.eventFile = eventFile;
            button = new FloatingButton(TogglePanel);
            timer = new System.Windows.Forms.Timer();
            timer.Interval = 250;
            timer.Tick += OnTick;
            timer.Start();
            WriteEvent("watch-started", "hidden", "startup");
            OnTick(this, EventArgs.Empty);
        }

        private void OnTick(object sender, EventArgs args)
        {
            if (stopEvent.WaitOne(0))
            {
                WriteEvent("watch-stopping", "closed", "stop-event");
                ExitThread();
                return;
            }

            IntPtr candidate = NativeWindows.FindTargetWindow(testTargetPid);
            bool candidateForeground = candidate != IntPtr.Zero && NativeWindows.IsForegroundOwner(candidate);
            ReportTestTarget(candidate, candidateForeground);
            if (candidateForeground)
            {
                Attach(candidate);
                return;
            }

            if (ownerWindow != IntPtr.Zero && NativeWindows.IsWindowActiveThroughOwnedPopup(ownerWindow, button, panel))
            {
                PlaceButton();
                if (panel != null && !panel.IsDisposed && panel.Visible) PlacePanel();
                return;
            }
            Detach();
        }

        private void ReportTestTarget(IntPtr candidate, bool foreground)
        {
            if (testTargetPid == 0 || (candidate == lastTestCandidate && lastTestCandidateForeground == foreground)) return;
            lastTestCandidate = candidate;
            lastTestCandidateForeground = foreground;
            if (candidate == IntPtr.Zero)
            {
                WriteEvent("test-target-missing", "hidden", "test-target-not-visible", candidate);
                return;
            }
            WriteEvent("test-target-selected", foreground ? "foreground" : "background",
                foreground ? "test-target-foreground" : "test-target-not-foreground", candidate);
        }

        private void Attach(IntPtr candidate)
        {
            if (ownerWindow != candidate)
            {
                HidePanel("owner-changed");
                ownerWindow = candidate;
            }

            NativeWindows.SetOwnedWindow(button.Handle, ownerWindow);
            PlaceButton();
            if (!button.Visible) button.Show();
            if (panel != null && !panel.IsDisposed && panel.Visible) PlacePanel();
            WriteEvent("attached", "shown", "codex-foreground");
        }

        private void Detach()
        {
            if (ownerWindow == IntPtr.Zero) return;
            HidePanel("codex-inactive");
            button.Hide();
            WriteEvent("detached", "hidden", "codex-inactive");
            ownerWindow = IntPtr.Zero;
        }

        private void TogglePanel()
        {
            if (ownerWindow == IntPtr.Zero) return;
            if (panel != null && panel.Visible)
            {
                HidePanel("button-toggle");
                return;
            }

            if (panel == null || panel.IsDisposed)
            {
                panel = new AssistantPanel(appRoot, testTargetPid != 0);
                panel.FormClosed += OnPanelClosed;
            }
            panel.SetHostWindow(ownerWindow);
            NativeWindows.SetOwnedWindow(panel.Handle, ownerWindow);
            panel.Show();
            PlacePanel();
            panel.RefreshAccount();
            WriteEvent("panel-opened", "shown", "button-toggle");
        }

        private void OnPanelClosed(object sender, FormClosedEventArgs args)
        {
            WriteEvent("panel-closed", "closed", "panel-closed");
            panel = null;
        }

        private void HidePanel(string reason)
        {
            if (panel != null && !panel.IsDisposed && panel.Visible)
            {
                panel.Hide();
                WriteEvent("panel-hidden", "hidden", reason);
            }
        }

        private void PlaceButton()
        {
            NativeWindows.RECT ownerRect;
            NativeWindows.RECT workArea;
            if (!NativeWindows.TryGetWindowAndWorkArea(ownerWindow, out ownerRect, out workArea)) return;
            int size = NativeWindows.ScaleForWindow(44, ownerWindow);
            int margin = NativeWindows.ScaleForWindow(12, ownerWindow);
            int x = Math.Max(workArea.Left + margin, Math.Min(ownerRect.Right - size - margin, workArea.Right - size - margin));
            int bodyOffset = NativeWindows.ScaleForWindow(88, ownerWindow);
            int y = Math.Max(workArea.Top + margin, Math.Min(ownerRect.Top + bodyOffset, workArea.Bottom - size - margin));
            button.SetBounds(x, y, size, size);
        }

        private void PlacePanel()
        {
            NativeWindows.RECT buttonRect;
            NativeWindows.RECT workArea;
            if (panel == null || !NativeWindows.TryGetWindowAndWorkArea(button.Handle, out buttonRect, out workArea)) return;
            int margin = NativeWindows.ScaleForWindow(8, ownerWindow);
            int x = Math.Max(workArea.Left + margin, Math.Min(buttonRect.Right - panel.Width, workArea.Right - panel.Width - margin));
            int y = buttonRect.Top - panel.Height - margin;
            if (y < workArea.Top + margin) y = buttonRect.Bottom + margin;
            y = Math.Max(workArea.Top + margin, Math.Min(y, workArea.Bottom - panel.Height - margin));
            NativeWindows.SetWindowPosition(panel.Handle, x, y);
        }

        private void WriteEvent(string eventName, string state, string reason)
        {
            WriteEvent(eventName, state, reason, IntPtr.Zero);
        }

        private void WriteEvent(string eventName, string state, string reason, IntPtr candidate)
        {
            if (string.IsNullOrEmpty(eventFile)) return;
            try
            {
                string directory = Path.GetDirectoryName(eventFile);
                if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
                File.AppendAllText(eventFile, "{\"timestamp\":\"" + DateTime.UtcNow.ToString("o") +
                    "\",\"event\":\"" + eventName + "\",\"state\":\"" + state +
                    "\",\"reason\":\"" + reason + "\",\"owner\":\"" + ownerWindow.ToInt64() +
                    "\",\"candidate\":\"" + candidate.ToInt64() +
                    "\",\"button\":" + WindowRectJson(button == null ? IntPtr.Zero : button.Handle) +
                    ",\"panel\":" + WindowRectJson(panel == null || panel.IsDisposed ? IntPtr.Zero : panel.Handle) + "}" +
                    Environment.NewLine, new UTF8Encoding(false));
            }
            catch (IOException)
            {
            }
        }

        private static string WindowRectJson(IntPtr window)
        {
            NativeWindows.RECT rectangle;
            if (!NativeWindows.TryGetWindowRect(window, out rectangle)) return "null";
            return "{\"left\":" + rectangle.Left + ",\"top\":" + rectangle.Top +
                ",\"right\":" + rectangle.Right + ",\"bottom\":" + rectangle.Bottom + "}";
        }

        protected override void ExitThreadCore()
        {
            Dispose();
            base.ExitThreadCore();
        }

        public new void Dispose()
        {
            if (disposed) return;
            disposed = true;
            timer.Stop();
            timer.Dispose();
            if (panel != null && !panel.IsDisposed)
            {
                panel.AllowExit = true;
                panel.Close();
                panel.Dispose();
            }
            button.Close();
            button.Dispose();
            WriteEvent("watch-stopped", "closed", "stopped");
        }
    }

    internal sealed class FloatingButton : Form
    {
        private readonly ToolTip tooltip;

        internal FloatingButton(Action onClick)
        {
            AutoScaleMode = AutoScaleMode.None;
            BackColor = Color.FromArgb(24, 89, 92);
            FormBorderStyle = FormBorderStyle.None;
            MaximizeBox = false;
            MinimizeBox = false;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            Button button = new Button();
            button.BackColor = Color.FromArgb(24, 89, 92);
            button.Dock = DockStyle.Fill;
            button.FlatAppearance.BorderSize = 0;
            button.FlatStyle = FlatStyle.Flat;
            button.Font = new Font("Segoe UI Symbol", 18.0f, FontStyle.Regular, GraphicsUnit.Point);
            button.ForeColor = Color.White;
            button.TabStop = false;
            button.Text = "\u221e";
            button.UseVisualStyleBackColor = false;
            button.Click += delegate { onClick(); };
            AccessibleName = "yisama\u65e0\u9650\u52a9\u624b";
            button.AccessibleName = "yisama\u65e0\u9650\u52a9\u624b";
            tooltip = new ToolTip();
            tooltip.SetToolTip(button, "yisama\u65e0\u9650\u52a9\u624b");
            Controls.Add(button);
        }

        protected override bool ShowWithoutActivation
        {
            get { return true; }
        }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams parameters = base.CreateParams;
                parameters.ExStyle |= 0x00000080;
                return parameters;
            }
        }
    }

    internal static class NativeWindows
    {
        internal struct RECT
        {
            internal int Left;
            internal int Top;
            internal int Right;
            internal int Bottom;
        }

        private struct MONITORINFO
        {
            internal int cbSize;
            internal RECT rcMonitor;
            internal RECT rcWork;
            internal int dwFlags;
        }

        private delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);

        private const int GA_ROOT = 2;
        private const uint MONITOR_DEFAULTTONEAREST = 2;
        private const int GWLP_HWNDPARENT = -8;
        private const uint SWP_NOSIZE = 0x0001;
        private const uint SWP_NOZORDER = 0x0004;
        private const uint SWP_NOACTIVATE = 0x0010;

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr window);
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern bool IsIconic(IntPtr window);
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern IntPtr GetAncestor(IntPtr window, uint flags);
        [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
        private static extern int GetClassName(IntPtr window, StringBuilder className, int maxCount);
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern bool GetWindowRect(IntPtr window, out RECT rectangle);
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
        [System.Runtime.InteropServices.DllImport("user32.dll", EntryPoint = "SetWindowLong")]
        private static extern int SetWindowLong32(IntPtr window, int index, int value);
        [System.Runtime.InteropServices.DllImport("user32.dll", EntryPoint = "SetWindowLongPtr")]
        private static extern IntPtr SetWindowLongPtr64(IntPtr window, int index, IntPtr value);
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern bool SetWindowPos(IntPtr window, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
        [System.Runtime.InteropServices.DllImport("user32.dll", EntryPoint = "GetDpiForWindow")]
        private static extern uint GetDpiForWindow(IntPtr window);
        [System.Runtime.InteropServices.DllImport("user32.dll", EntryPoint = "SetProcessDpiAwarenessContext")]
        private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [System.Runtime.InteropServices.DllImport("shcore.dll", EntryPoint = "SetProcessDpiAwareness")]
        private static extern int SetProcessDpiAwareness(int value);
        [System.Runtime.InteropServices.DllImport("user32.dll", EntryPoint = "SetProcessDPIAware")]
        private static extern bool SetProcessDPIAware();

        internal static void EnablePerMonitorDpiAwareness()
        {
            try
            {
                if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return;
            }
            catch (EntryPointNotFoundException)
            {
            }
            try
            {
                if (SetProcessDpiAwareness(2) == 0) return;
            }
            catch (System.DllNotFoundException)
            {
            }
            catch (EntryPointNotFoundException)
            {
            }
            try
            {
                SetProcessDPIAware();
            }
            catch (EntryPointNotFoundException)
            {
            }
        }

        internal static IntPtr FindTargetWindow(int testTargetPid)
        {
            IntPtr result = IntPtr.Zero;
            EnumWindows(delegate(IntPtr window, IntPtr unused)
            {
                if (!IsWindowVisible(window)) return true;
                uint processId;
                GetWindowThreadProcessId(window, out processId);
                if (testTargetPid != 0)
                {
                    if (processId == (uint)testTargetPid)
                    {
                        result = window;
                        return false;
                    }
                    return true;
                }
                if (!HasChromeWidgetClass(window) || !IsCodexProcess((int)processId)) return true;
                result = window;
                return false;
            }, IntPtr.Zero);
            return result;
        }

        internal static bool IsForegroundOwner(IntPtr owner)
        {
            if (owner == IntPtr.Zero || IsIconic(owner)) return false;
            IntPtr foreground = GetForegroundWindow();
            return foreground != IntPtr.Zero && GetAncestor(foreground, GA_ROOT) == owner;
        }

        internal static bool IsWindowActiveThroughOwnedPopup(IntPtr owner, Form button, Form panel)
        {
            if (owner == IntPtr.Zero || IsIconic(owner)) return false;
            IntPtr foreground = GetForegroundWindow();
            if (foreground == IntPtr.Zero) return false;
            IntPtr root = GetAncestor(foreground, GA_ROOT);
            if (root == owner) return true;
            if (button != null && root == button.Handle) return true;
            return panel != null && !panel.IsDisposed && root == panel.Handle;
        }

        internal static void SetOwnedWindow(IntPtr child, IntPtr owner)
        {
            if (child == IntPtr.Zero) return;
            if (IntPtr.Size == 8) SetWindowLongPtr64(child, GWLP_HWNDPARENT, owner);
            else SetWindowLong32(child, GWLP_HWNDPARENT, owner.ToInt32());
        }

        internal static bool TryGetWindowAndWorkArea(IntPtr window, out RECT rectangle, out RECT workArea)
        {
            rectangle = new RECT();
            workArea = new RECT();
            if (!GetWindowRect(window, out rectangle)) return false;
            IntPtr monitor = MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST);
            if (monitor == IntPtr.Zero) return false;
            MONITORINFO info = new MONITORINFO();
            info.cbSize = System.Runtime.InteropServices.Marshal.SizeOf(typeof(MONITORINFO));
            if (!GetMonitorInfo(monitor, ref info)) return false;
            workArea = info.rcWork;
            return true;
        }

        internal static bool TryGetWindowRect(IntPtr window, out RECT rectangle)
        {
            rectangle = new RECT();
            return window != IntPtr.Zero && GetWindowRect(window, out rectangle);
        }

        internal static int ScaleForWindow(int logicalPixels, IntPtr window)
        {
            try
            {
                uint dpi = GetDpiForWindow(window);
                if (dpi > 0) return Math.Max(1, (int)Math.Round(logicalPixels * dpi / 96.0));
            }
            catch (EntryPointNotFoundException)
            {
            }
            return logicalPixels;
        }

        internal static void SetWindowPosition(IntPtr window, int x, int y)
        {
            SetWindowPos(window, IntPtr.Zero, x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
        }

        private static bool HasChromeWidgetClass(IntPtr window)
        {
            StringBuilder value = new StringBuilder(64);
            GetClassName(window, value, value.Capacity);
            return string.Equals(value.ToString(), "Chrome_WidgetWin_1", StringComparison.Ordinal);
        }

        private static bool IsCodexProcess(int processId)
        {
            try
            {
                using (Process process = Process.GetProcessById(processId))
                {
                    return process.ProcessName.IndexOf("codex", StringComparison.OrdinalIgnoreCase) >= 0;
                }
            }
            catch (ArgumentException)
            {
                return false;
            }
        }
    }
}
