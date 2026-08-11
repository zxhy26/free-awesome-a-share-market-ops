using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

[assembly: AssemblyTitle("A股复盘Windows版 - 定制短线")]
[assembly: AssemblyProduct("A股复盘")]
[assembly: AssemblyDescription("复用单一本地后台服务的A股复盘定制版窗口")]
[assembly: AssemblyVersion("1.0.5.0")]
[assembly: AssemblyFileVersion("1.0.5.0")]

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        string offlinePath = Path.Combine(root, "离线复盘.html");
        string nodePath = Path.Combine(root, "运行环境", "node.exe");
        string appDir = Path.Combine(root, "程序", "应用");
        string servicePath = Path.Combine(appDir, "backend", "复盘同步服务.js");
        int port = ResolvePort();
        string baseUrl = "http://127.0.0.1:" + port.ToString();
        string metaUrl = baseUrl + "/api/v1/meta";
        string appUrl = baseUrl + "/app/";
        string target = File.Exists(offlinePath) ? new Uri(offlinePath).AbsoluteUri : "about:blank";
        Process localService = null;
        bool liveMode = false;

        WriteDiagnostic(root, "启动，目标单服务端口 " + port.ToString());
        try
        {
            // The scheduled background task starts immediately before this host. Give it
            // enough time to bind the canonical port, then reuse it instead of creating a
            // second backend with a different release identity.
            for (int attempt = 0; attempt < 48 && !ExpectedCustomServiceReady(metaUrl); attempt++)
            {
                Thread.Sleep(250);
            }

            if (!ExpectedCustomServiceReady(metaUrl)
                && PortAvailable(port)
                && File.Exists(nodePath)
                && File.Exists(servicePath)
                && File.Exists(Path.Combine(appDir, "index.html")))
            {
                localService = StartLocalService(root, nodePath, appDir, servicePath, port);
                WriteDiagnostic(root, "后台任务未就绪，窗口补启动服务 PID=" + (localService == null ? "0" : localService.Id.ToString()));
                for (int attempt = 0; attempt < 80 && !ExpectedCustomServiceReady(metaUrl); attempt++)
                {
                    if (localService != null && localService.HasExited) break;
                    Thread.Sleep(250);
                }
            }

            if (ExpectedCustomServiceReady(metaUrl))
            {
                liveMode = true;
                target = appUrl;
                WriteDiagnostic(root, "已复用定制短线单服务 " + baseUrl);
            }
            else
            {
                WriteDiagnostic(root, "拒绝连接身份不符或未就绪的后台服务 " + baseUrl);
            }

            if (target == "about:blank")
            {
                MessageBox.Show(
                    "程序文件不完整，无法启动定制短线服务，也找不到离线页面。请重新安装定制版。",
                    "A股复盘定制版",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                return;
            }

            if (liveMode && String.Equals(
                Environment.GetEnvironmentVariable("A_SHARE_REVIEW_HEADLESS_VERIFY"),
                "1",
                StringComparison.Ordinal))
            {
                WriteDiagnostic(root, "成品门禁已确认单服务，跳过WebView缓存初始化");
                return;
            }

            Application.Run(new ReviewForm(target, offlinePath, liveMode));
        }
        catch (Exception error)
        {
            WriteDiagnostic(root, "启动失败：" + error.Message);
            if (File.Exists(offlinePath))
            {
                Application.Run(new ReviewForm(new Uri(offlinePath).AbsoluteUri, offlinePath, false));
            }
            else
            {
                MessageBox.Show("启动失败：" + error.Message, "A股复盘定制版", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
        // Do not kill localService here. It is the canonical background service and must
        // keep the 09:15 monitor alive after the window closes.
    }

    private static int ResolvePort()
    {
        int port;
        string configured = Environment.GetEnvironmentVariable("A_SHARE_REVIEW_LAUNCH_PORT") ?? "";
        if (Int32.TryParse(configured, out port) && port >= 1024 && port <= 65535) return port;
        return 18765;
    }

    private static Process StartLocalService(string root, string nodePath, string appDir, string servicePath, int port)
    {
        ProcessStartInfo info = new ProcessStartInfo();
        info.FileName = nodePath;
        info.Arguments = Quote(servicePath);
        info.WorkingDirectory = Path.GetDirectoryName(servicePath);
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.WindowStyle = ProcessWindowStyle.Hidden;
        info.EnvironmentVariables["A_SHARE_REVIEW_PORT"] = port.ToString();
        info.EnvironmentVariables["A_SHARE_REVIEW_HOST"] = "127.0.0.1";
        info.EnvironmentVariables["A_SHARE_REVIEW_PORTABLE_ROOT"] = root;
        info.EnvironmentVariables["A_SHARE_REVIEW_APP_DIR"] = appDir;
        info.EnvironmentVariables["A_SHARE_REVIEW_NODE"] = nodePath;
        info.EnvironmentVariables["A_SHARE_REVIEW_HISTORY_DIR"] = Path.Combine(root, "数据历史", "结构化复盘历史");
        info.EnvironmentVariables["A_SHARE_REVIEW_LEGACY_HISTORY_DIR"] = Path.Combine(root, "数据历史", "每日完整数据");
        info.EnvironmentVariables["A_SHARE_REVIEW_EDITION"] = Environment.GetEnvironmentVariable("A_SHARE_REVIEW_EDITION") ?? "basic";
        info.EnvironmentVariables["A_SHARE_REVIEW_RELEASE_EDITION"] = "custom";
        info.EnvironmentVariables["A_SHARE_REVIEW_LAUNCHER_VERSION"] = Environment.GetEnvironmentVariable("A_SHARE_REVIEW_LAUNCHER_VERSION") ?? "";
        info.EnvironmentVariables["A_SHARE_REVIEW_UPDATE_MANIFEST_URL"] = Environment.GetEnvironmentVariable("A_SHARE_REVIEW_UPDATE_MANIFEST_URL") ?? "";
        return Process.Start(info);
    }

    private static bool ExpectedCustomServiceReady(string metaUrl)
    {
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(metaUrl);
            request.Method = "GET";
            request.Proxy = null;
            request.Timeout = 900;
            request.ReadWriteTimeout = 900;
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            using (Stream stream = response.GetResponseStream())
            using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
            {
                string body = reader.ReadToEnd();
                return response.StatusCode == HttpStatusCode.OK
                    && body.IndexOf("\"releaseEdition\":\"custom\"", StringComparison.OrdinalIgnoreCase) >= 0
                    && body.IndexOf("\"shortline\"", StringComparison.OrdinalIgnoreCase) >= 0;
            }
        }
        catch
        {
            return false;
        }
    }

    private static bool PortAvailable(int port)
    {
        TcpListener listener = null;
        try
        {
            listener = new TcpListener(IPAddress.Loopback, port);
            listener.Start();
            return true;
        }
        catch
        {
            return false;
        }
        finally
        {
            if (listener != null) listener.Stop();
        }
    }

    private static string Quote(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    internal static void WriteDiagnostic(string root, string message)
    {
        try
        {
            string cacheDir = Path.Combine(root, "缓存");
            Directory.CreateDirectory(cacheDir);
            File.AppendAllText(
                Path.Combine(cacheDir, "启动诊断.log"),
                "[" + DateTime.Now.ToString("yyyy/MM/dd HH:mm:ss.fff") + "] " + message + Environment.NewLine,
                new UTF8Encoding(false));
        }
        catch
        {
        }
    }
}

internal sealed class ReviewForm : Form
{
    private readonly string targetUrl;
    private readonly string offlineUrl;
    private readonly bool liveMode;
    private WebView2 webView;
    private Label loadingLabel;
    private bool switchedToOffline;

    internal ReviewForm(string targetUrl, string offlinePath, bool liveMode)
    {
        this.targetUrl = targetUrl;
        this.offlineUrl = File.Exists(offlinePath) ? new Uri(offlinePath).AbsoluteUri : "";
        this.liveMode = liveMode;
        Text = liveMode ? "A股复盘 - 实时同步" : "A股复盘 - 内置完整页面";
        Icon = SystemIcons.Application;
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(900, 620);
        Rectangle area = Screen.PrimaryScreen.WorkingArea;
        Size = new Size(Math.Min(1440, Math.Max(900, area.Width - 36)), Math.Min(900, Math.Max(620, area.Height - 36)));
        BackColor = Color.FromArgb(43, 48, 54);

        loadingLabel = new Label();
        loadingLabel.Dock = DockStyle.Fill;
        loadingLabel.TextAlign = ContentAlignment.MiddleCenter;
        loadingLabel.ForeColor = Color.WhiteSmoke;
        loadingLabel.Font = new Font("Microsoft YaHei UI", 13F, FontStyle.Regular);
        loadingLabel.Text = liveMode ? "正在连接实时复盘服务…" : "正在打开内置完整复盘页面…";
        Controls.Add(loadingLabel);
        Shown += OnShown;
    }

    private async void OnShown(object sender, EventArgs eventArgs)
    {
        await InitializeBrowser();
    }

    private async Task InitializeBrowser()
    {
        try
        {
            webView = new WebView2();
            webView.Dock = DockStyle.Fill;
            Controls.Add(webView);
            webView.BringToFront();
            string userData = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "缓存", "WebView2");
            Directory.CreateDirectory(userData);
            CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(null, userData);
            await webView.EnsureCoreWebView2Async(environment);
            webView.CoreWebView2.Settings.AreDevToolsEnabled = false;
            webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
            webView.NavigationCompleted += OnNavigationCompleted;
            webView.Source = new Uri(targetUrl);
            Program.WriteDiagnostic(AppDomain.CurrentDomain.BaseDirectory, "浏览器已导航到 " + targetUrl);
        }
        catch (Exception error)
        {
            ShowExternalBrowserFallback(error.Message);
        }
    }

    private void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs args)
    {
        if (args.IsSuccess)
        {
            if (loadingLabel != null) loadingLabel.Visible = false;
            return;
        }
        if (!switchedToOffline && offlineUrl.Length > 0 && webView != null
            && !String.Equals(webView.Source.AbsoluteUri, offlineUrl, StringComparison.OrdinalIgnoreCase))
        {
            switchedToOffline = true;
            Text = "A股复盘 - 内置完整页面";
            webView.Source = new Uri(offlineUrl);
            return;
        }
        ShowExternalBrowserFallback("页面加载失败：" + args.WebErrorStatus.ToString());
    }

    private void ShowExternalBrowserFallback(string reason)
    {
        string url = liveMode ? targetUrl : (offlineUrl.Length > 0 ? offlineUrl : targetUrl);
        if (webView != null)
        {
            try { webView.Dispose(); } catch { }
            webView = null;
        }
        Controls.Clear();
        Label detail = new Label();
        detail.Dock = DockStyle.Fill;
        detail.TextAlign = ContentAlignment.MiddleCenter;
        detail.Font = new Font("Microsoft YaHei UI", 11F);
        detail.ForeColor = Color.WhiteSmoke;
        detail.Text = "WebView2 暂不可用，已改用系统浏览器打开。\r\n" + reason;
        Controls.Add(detail);
        OpenExternal(url);
    }

    private static void OpenExternal(string url)
    {
        try
        {
            ProcessStartInfo info = new ProcessStartInfo();
            info.FileName = url;
            info.UseShellExecute = true;
            Process.Start(info);
        }
        catch
        {
        }
    }
}
