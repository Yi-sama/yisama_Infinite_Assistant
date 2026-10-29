using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Windows.Forms;
using Microsoft.Win32;

namespace YisamaSetup
{
    internal static class InstallerProgram
    {
        internal const string LegacyRunValueName = "YisamaInfiniteAssistant";

        [STAThread]
        private static int Main(string[] args)
        {
            DpiAwareness.EnablePerMonitorDpiAwareness();
            if (args.Length == 1 && string.Equals(args[0], "--dry-run", StringComparison.OrdinalIgnoreCase)) return Installer.DryRun();
            if (args.Length == 2 && string.Equals(args[0], "--extract-test", StringComparison.OrdinalIgnoreCase)) return Installer.ExtractTest(args[1]);
            if (args.Length == 1 && string.Equals(args[0], "--uninstall", StringComparison.OrdinalIgnoreCase))
            {
                try
                {
                    Installer.Uninstall();
                    return 0;
                }
                catch
                {
                    Console.Error.WriteLine("Restore did not complete. The assistant shortcuts and backups were kept.");
                    return 1;
                }
            }
            if (args.Length != 0)
            {
                Console.Error.WriteLine("Usage: Yisama-Setup.exe [--dry-run | --extract-test <temp-root> | --uninstall]");
                return 2;
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new InstallForm());
            return 0;
        }
    }

    internal sealed class InstallForm : Form
    {
        private readonly CheckBox acknowledgement;
        private readonly Button install;

        internal InstallForm()
        {
            Text = "\u5b89\u88c5 yisama \u65e0\u9650\u52a9\u624b";
            ClientSize = new Size(600, 315);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;

            Label disclosure = new Label();
            disclosure.AutoSize = false;
            disclosure.Location = new Point(20, 20);
            disclosure.Size = new Size(560, 185);
            disclosure.Text = "\u6b64\u5b89\u88c5\u7a0b\u5e8f\u4ec5\u4e3a\u5f53\u524d Windows \u7528\u6237\u590d\u5236 yisama \u542f\u52a8\u7ec4\u4ef6\u3002\r\n\r\n" +
                "\u5b89\u88c5\u5b8c\u6210\u540e\uff0c\u8bf7\u4f7f\u7528\u684c\u9762\u6216\u5f00\u59cb\u83dc\u5355\u4e2d\u7684\u201cCodex - yisama\u201d\u5feb\u6377\u65b9\u5f0f\u542f\u52a8 Codex\u3002\u8be5\u5feb\u6377\u65b9\u5f0f\u4f1a\u542f\u7528\u5ba2\u6237\u7aef\u5185\u7684 yisama \u52a9\u624b\u5165\u53e3\u3002\r\n\r\n" +
                "\u539f\u6709 Codex \u5feb\u6377\u65b9\u5f0f\u4e0d\u4f1a\u81ea\u52a8\u542f\u7528 yisama\u3002\u5b89\u88c5\u7a0b\u5e8f\u4e0d\u521b\u5efa Windows \u767b\u5f55\u76d1\u89c6\u7a0b\u5e8f\uff0c\u4e0d\u4f1a\u505c\u6b62\u3001\u91cd\u542f\u3001\u4fee\u6539\u6216\u8865\u4e01 Codex\u3002\r\n\r\n" +
                "\u8bf7\u5148\u5173\u95ed\u6240\u6709 Codex \u684c\u9762\u8fdb\u7a0b\u3002\u5b89\u88c5\u4e0d\u767b\u5f55\u3001\u4e0d\u66f4\u6539\u5e10\u6237\u6216\u51ed\u8bc1\u3002";
            Controls.Add(disclosure);

            acknowledgement = new CheckBox();
            acknowledgement.AutoSize = false;
            acknowledgement.Location = new Point(20, 215);
            acknowledgement.Size = new Size(560, 32);
            acknowledgement.Text = "\u6211\u4e86\u89e3\uff1a\u4eca\u540e\u9700\u4f7f\u7528\u201cCodex - yisama\u201d\u5feb\u6377\u65b9\u5f0f\u542f\u52a8\u542b yisama \u7684 Codex\u3002";
            acknowledgement.CheckedChanged += delegate { install.Enabled = acknowledgement.Checked; };
            Controls.Add(acknowledgement);

            install = new Button();
            install.Enabled = false;
            install.Location = new Point(385, 265);
            install.Size = new Size(195, 30);
            install.Text = "\u4e3a\u5f53\u524d\u7528\u6237\u5b89\u88c5";
            install.Click += InstallClicked;
            Controls.Add(install);

            Button cancel = new Button();
            cancel.DialogResult = DialogResult.Cancel;
            cancel.Location = new Point(280, 265);
            cancel.Size = new Size(95, 30);
            cancel.Text = "\u53d6\u6d88";
            Controls.Add(cancel);
            CancelButton = cancel;
        }

        private void InstallClicked(object sender, EventArgs args)
        {
            install.Enabled = false;
            try
            {
                Installer.Install();
                MessageBox.Show(this, "\u5b89\u88c5\u5b8c\u6210\u3002\u8bf7\u4f7f\u7528\u201cCodex - yisama\u201d\u5feb\u6377\u65b9\u5f0f\u542f\u52a8 Codex\u3002", Text,
                    MessageBoxButtons.OK, MessageBoxIcon.Information);
                Close();
            }
            catch (Exception exception)
            {
                MessageBox.Show(this, "\u5b89\u88c5\u672a\u5b8c\u6210\u3002\r\n\r\n" + exception.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
                install.Enabled = acknowledgement.Checked;
            }
        }
    }

    internal static class Installer
    {
        internal static string AppRoot
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "yisama-infinite-assistant"); }
        }

        internal static int DryRun()
        {
            Console.WriteLine("Target: " + AppRoot);
            if (CodexDesktop.HasRunningInstance())
            {
                Console.WriteLine("BLOCKED: close every Codex desktop instance before installation.");
                return 2;
            }
            Console.WriteLine("Would extract the bundled Node runtime, scripts, and dependencies to the target directory.");
            Console.WriteLine("Would create guarded current-user shortcuts named Codex - yisama on the desktop and Start menu.");
            Console.WriteLine("Would remove only the legacy Run value when its value is exactly the prior installed Host.exe --watch command.");
            Console.WriteLine("Dry run completed without writing files, registry values, shortcuts, account configuration, or credentials.");
            return 0;
        }

        internal static int ExtractTest(string root)
        {
            if (string.IsNullOrEmpty(root) || !Path.IsPathRooted(root))
            {
                Console.Error.WriteLine("--extract-test requires an explicit absolute temporary directory.");
                return 2;
            }
            string fullRoot = Path.GetFullPath(root);
            string tempRoot = Path.GetFullPath(Path.GetTempPath());
            if (!IsChildPath(fullRoot, tempRoot))
            {
                Console.Error.WriteLine("--extract-test output must be a child of the current temporary directory.");
                return 2;
            }
            Directory.CreateDirectory(fullRoot);
            string destination = Path.Combine(fullRoot, "yisama-payload-" + Guid.NewGuid().ToString("N"));
            ExtractPayload(destination);
            Console.WriteLine("Extracted payload only: " + destination);
            return 0;
        }

        internal static void Install()
        {
            if (CodexDesktop.HasRunningInstance())
            {
                throw new InvalidOperationException("\u8bf7\u5148\u5173\u95ed\u6240\u6709 Codex \u684c\u9762\u8fdb\u7a0b\u3002\u5b89\u88c5\u7a0b\u5e8f\u4e0d\u4f1a\u505c\u6b62\u6216\u91cd\u542f\u5b83\u4eec\u3002");
            }
            string staging = Path.Combine(Path.GetTempPath(), "yisama-install-" + Guid.NewGuid().ToString("N"));
            try
            {
                ExtractPayload(staging);
                CopyDirectory(staging, AppRoot);
                ShortcutManager.CreateOwnedShortcuts(AppRoot);
                RemoveOwnedLegacyRunEntry();
            }
            finally
            {
                RemoveGeneratedStagingDirectory(staging);
            }
        }

        internal static void Uninstall()
        {
            if (CodexDesktop.HasRunningInstance())
                throw new InvalidOperationException("Close Codex before restoring and uninstalling.");
            string pluginData = Environment.GetEnvironmentVariable("PLUGIN_DATA");
            if (string.IsNullOrEmpty(pluginData)) pluginData = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".yisama-infinite-assistant");
            if (File.Exists(Path.Combine(pluginData, "state.json")))
            {
                string node = Path.Combine(AppRoot, "runtime", "node.exe");
                string script = Path.Combine(AppRoot, "scripts", "yisama.mjs");
                if (!File.Exists(node) || !File.Exists(script))
                    throw new InvalidOperationException("The installed restore component is missing.");
                ProcessStartInfo start = new ProcessStartInfo(node, "\"" + script + "\" restore");
                start.UseShellExecute = false;
                start.CreateNoWindow = true;
                start.WindowStyle = ProcessWindowStyle.Hidden;
                start.RedirectStandardOutput = true;
                start.RedirectStandardError = true;
                using (Process process = Process.Start(start))
                {
                    process.OutputDataReceived += delegate { };
                    process.ErrorDataReceived += delegate { };
                    process.BeginOutputReadLine();
                    process.BeginErrorReadLine();
                    process.WaitForExit();
                    if (process.ExitCode != 0) throw new InvalidOperationException("Restore failed.");
                }
                if (File.Exists(Path.Combine(pluginData, "state.json")))
                    throw new InvalidOperationException("Restore is incomplete.");
            }
            ShortcutManager.RemoveOwnedShortcuts(AppRoot);
            RemoveOwnedLegacyRunEntry();
        }

        private static void ExtractPayload(string destination)
        {
            string root = Path.GetFullPath(destination);
            Directory.CreateDirectory(root);
            string rootPrefix = root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
            Assembly assembly = Assembly.GetExecutingAssembly();
            using (Stream stream = assembly.GetManifestResourceStream("payload.zip"))
            {
                if (stream == null) throw new InvalidOperationException("\u5b89\u88c5\u5305\u4e0d\u5b8c\u6574\u3002");
                using (ZipArchive archive = new ZipArchive(stream, ZipArchiveMode.Read))
                {
                    foreach (ZipArchiveEntry entry in archive.Entries)
                    {
                        string target = Path.GetFullPath(Path.Combine(root, entry.FullName));
                        if (!target.StartsWith(rootPrefix, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("\u5b89\u88c5\u5305\u5305\u542b\u65e0\u6548\u8def\u5f84\u3002");
                        if (string.IsNullOrEmpty(entry.Name)) { Directory.CreateDirectory(target); continue; }
                        Directory.CreateDirectory(Path.GetDirectoryName(target));
                        using (Stream input = entry.Open())
                        using (FileStream output = new FileStream(target, FileMode.Create, FileAccess.Write, FileShare.None)) input.CopyTo(output);
                    }
                }
            }
        }

        private static void CopyDirectory(string source, string destination)
        {
            Directory.CreateDirectory(destination);
            foreach (string directory in Directory.GetDirectories(source, "*", SearchOption.AllDirectories))
            {
                string relative = directory.Substring(source.Length).TrimStart(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                Directory.CreateDirectory(Path.Combine(destination, relative));
            }
            foreach (string file in Directory.GetFiles(source, "*", SearchOption.AllDirectories))
            {
                string relative = file.Substring(source.Length).TrimStart(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                string target = Path.Combine(destination, relative);
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                File.Copy(file, target, true);
            }
        }

        private static void RemoveOwnedLegacyRunEntry()
        {
            string expected = "\"" + Path.Combine(AppRoot, "Host.exe") + "\" --watch";
            using (RegistryKey run = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true))
            {
                if (run == null) return;
                string existing = run.GetValue(InstallerProgram.LegacyRunValueName) as string;
                if (string.Equals(existing, expected, StringComparison.OrdinalIgnoreCase)) run.DeleteValue(InstallerProgram.LegacyRunValueName, false);
            }
        }

        private static bool IsChildPath(string path, string parent)
        {
            string normalizedPath = Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string normalizedParent = Path.GetFullPath(parent).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            return normalizedPath.StartsWith(normalizedParent + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
        }

        private static void RemoveGeneratedStagingDirectory(string staging)
        {
            if (!Directory.Exists(staging)) return;
            string fullPath = Path.GetFullPath(staging);
            string tempPath = Path.GetFullPath(Path.GetTempPath());
            string prefix = tempPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
            string leaf = Path.GetFileName(fullPath);
            Guid ignored;
            if (!fullPath.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) || !leaf.StartsWith("yisama-install-", StringComparison.OrdinalIgnoreCase) || !Guid.TryParseExact(leaf.Substring("yisama-install-".Length), "N", out ignored))
                throw new InvalidOperationException("\u5b89\u88c5\u4e34\u65f6\u76ee\u5f55\u9a8c\u8bc1\u5931\u8d25\u3002");
            Directory.Delete(fullPath, true);
        }
    }

    internal static class ShortcutManager
    {
        private const string ShortcutName = "Codex - yisama.lnk";

        internal static void CreateOwnedShortcuts(string appRoot)
        {
            foreach (string path in ShortcutPaths()) CreateOrVerify(path, appRoot);
        }

        internal static void RemoveOwnedShortcuts(string appRoot)
        {
            foreach (string path in ShortcutPaths()) if (File.Exists(path) && IsOwned(path, appRoot)) File.Delete(path);
        }

        private static IEnumerable<string> ShortcutPaths()
        {
            yield return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), ShortcutName);
            yield return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), ShortcutName);
        }

        private static void CreateOrVerify(string shortcutPath, string appRoot)
        {
            if (File.Exists(shortcutPath))
            {
                if (!IsOwned(shortcutPath, appRoot)) throw new InvalidOperationException("\u5df2\u5b58\u5728\u540c\u540d\u4e14\u4e0d\u5c5e\u4e8e yisama \u7684\u5feb\u6377\u65b9\u5f0f\uff1a" + shortcutPath);
                return;
            }
            Directory.CreateDirectory(Path.GetDirectoryName(shortcutPath));
            object shell = CreateShell();
            try
            {
                object shortcut = Invoke(shell, "CreateShortcut", BindingFlags.InvokeMethod, new object[] { shortcutPath });
                try
                {
                    Set(shortcut, "TargetPath", PowerShellPath());
                    Set(shortcut, "Arguments", PowerShellArguments(appRoot));
                    Set(shortcut, "WorkingDirectory", appRoot);
                    Set(shortcut, "WindowStyle", 7);
                    Set(shortcut, "Description", "Launch Codex with yisama Infinite Assistant");
                    Invoke(shortcut, "Save", BindingFlags.InvokeMethod, null);
                }
                finally { ReleaseCom(shortcut); }
            }
            finally { ReleaseCom(shell); }
        }

        private static bool IsOwned(string shortcutPath, string appRoot)
        {
            object shell = CreateShell();
            try
            {
                object shortcut = Invoke(shell, "CreateShortcut", BindingFlags.InvokeMethod, new object[] { shortcutPath });
                try
                {
                    return string.Equals(Get(shortcut, "TargetPath"), PowerShellPath(), StringComparison.OrdinalIgnoreCase) && string.Equals(Get(shortcut, "Arguments"), PowerShellArguments(appRoot), StringComparison.Ordinal);
                }
                finally { ReleaseCom(shortcut); }
            }
            finally { ReleaseCom(shell); }
        }

        private static object CreateShell()
        {
            Type type = Type.GetTypeFromProgID("WScript.Shell");
            if (type == null) throw new InvalidOperationException("Windows \u5feb\u6377\u65b9\u5f0f\u7ec4\u4ef6\u4e0d\u53ef\u7528\u3002");
            return Activator.CreateInstance(type);
        }

        private static object Invoke(object target, string name, BindingFlags operation, object[] arguments)
        {
            return target.GetType().InvokeMember(name, operation, null, target, arguments);
        }

        private static string Get(object target, string name) { return Convert.ToString(Invoke(target, name, BindingFlags.GetProperty, null)); }
        private static void Set(object target, string name, object value) { Invoke(target, name, BindingFlags.SetProperty, new object[] { value }); }
        private static string PowerShellPath() { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe"); }
        private static string PowerShellArguments(string appRoot) { return "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + Path.Combine(appRoot, "scripts", "launch-codex.ps1") + "\""; }

        private static void ReleaseCom(object value)
        {
            if (value != null && System.Runtime.InteropServices.Marshal.IsComObject(value)) System.Runtime.InteropServices.Marshal.FinalReleaseComObject(value);
        }
    }

    internal static class CodexDesktop
    {
        internal static bool HasRunningInstance()
        {
            foreach (Process process in FindRunningInstances()) { process.Dispose(); return true; }
            return false;
        }

        internal static List<Process> FindRunningInstances()
        {
            List<Process> result = new List<Process>();
            foreach (string name in new[] { "ChatGPT", "Codex" })
            {
                foreach (Process process in Process.GetProcessesByName(name))
                {
                    if (IsCodexDesktopProcess(process)) result.Add(process); else process.Dispose();
                }
            }
            return result;
        }

        private static bool IsCodexDesktopProcess(Process process)
        {
            try { return IsCodexDesktopPath(process.MainModule.FileName); }
            catch (InvalidOperationException) { return false; }
            catch (System.ComponentModel.Win32Exception) { return false; }
        }

        private static bool IsCodexDesktopPath(string path)
        {
            if (string.IsNullOrEmpty(path)) return false;
            string fullPath = Path.GetFullPath(path);
            string fileName = Path.GetFileName(fullPath);
            if (!string.Equals(fileName, "ChatGPT.exe", StringComparison.OrdinalIgnoreCase) && !string.Equals(fileName, "Codex.exe", StringComparison.OrdinalIgnoreCase)) return false;
            string localInstall = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Codex");
            if (string.Equals(Path.GetDirectoryName(fullPath), localInstall, StringComparison.OrdinalIgnoreCase)) return true;
            string appDirectory = Path.GetDirectoryName(fullPath);
            string packageDirectory = Path.GetDirectoryName(appDirectory);
            return string.Equals(Path.GetFileName(appDirectory), "app", StringComparison.OrdinalIgnoreCase) &&
                Path.GetFileName(packageDirectory).StartsWith("OpenAI.Codex_", StringComparison.OrdinalIgnoreCase) &&
                string.Equals(Path.GetFileName(Path.GetDirectoryName(packageDirectory)), "WindowsApps", StringComparison.OrdinalIgnoreCase);
        }
    }

    internal static class DpiAwareness
    {
        [System.Runtime.InteropServices.DllImport("user32.dll", EntryPoint = "SetProcessDpiAwarenessContext")]
        private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [System.Runtime.InteropServices.DllImport("shcore.dll", EntryPoint = "SetProcessDpiAwareness")]
        private static extern int SetProcessDpiAwareness(int value);
        [System.Runtime.InteropServices.DllImport("user32.dll", EntryPoint = "SetProcessDPIAware")]
        private static extern bool SetProcessDPIAware();

        internal static void EnablePerMonitorDpiAwareness()
        {
            try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; }
            catch (EntryPointNotFoundException) { }
            try { if (SetProcessDpiAwareness(2) == 0) return; }
            catch (System.DllNotFoundException) { }
            catch (EntryPointNotFoundException) { }
            try { SetProcessDPIAware(); }
            catch (EntryPointNotFoundException) { }
        }
    }
}
