using System;
using System.Drawing;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace Yisama.Testing
{
    internal static class FixtureWindow
    {
        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            using (var form = new Form())
            {
                form.Text = "Yisama isolated attachment fixture";
                form.ClientSize = new Size(880, 650);
                form.StartPosition = FormStartPosition.Manual;
                form.Location = new Point(80, 80);
                form.BackColor = Color.FromArgb(242, 244, 243);
                var heading = new Label { Text = "Isolated Codex window fixture", AutoSize = true,
                    Font = new Font("Segoe UI", 18), Location = new Point(32, 36) };
                form.Controls.Add(heading);
                form.Shown += delegate
                {
                    Console.WriteLine("ready");
                    Console.Out.Flush();
                };
                var reader = new Thread(delegate()
                {
                    string line;
                    while ((line = Console.ReadLine()) != null)
                    {
                        string command = line;
                        if (form.IsDisposed) break;
                        try
                        {
                            form.BeginInvoke(new Action(delegate
                            {
                                if (command == "move") form.Location = new Point(180, 130);
                                else if (command == "minimize") form.WindowState = FormWindowState.Minimized;
                                else if (command == "restore")
                                {
                                    form.WindowState = FormWindowState.Normal;
                                    form.Activate();
                                }
                                else if (command == "focus") form.Activate();
                                else if (command == "close") form.Close();
                                else if (command.StartsWith("capture "))
                                {
                                    string target = command.Substring(8);
                                    using (var image = new Bitmap(form.Width, form.Height))
                                    {
                                        form.DrawToBitmap(image, new Rectangle(0, 0, form.Width, form.Height));
                                        image.Save(target);
                                    }
                                }
                                Console.WriteLine(command);
                                Console.Out.Flush();
                            }));
                        }
                        catch (InvalidOperationException) { break; }
                    }
                    if (!form.IsDisposed)
                    {
                        try { form.BeginInvoke(new Action(form.Close)); }
                        catch (InvalidOperationException) { }
                    }
                });
                reader.IsBackground = true;
                reader.Start();
                Application.Run(form);
            }
        }
    }
}
