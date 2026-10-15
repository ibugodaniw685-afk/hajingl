using System.Diagnostics;
using System.IO.Compression;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Windows.Forms;

namespace BiliSpeechLauncher;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new LauncherForm());
    }
}

internal sealed class LauncherForm : Form
{
    private const string AppUrl = "http://127.0.0.1:18437";
    private const string ResourceRoot = "BiliSpeechLauncher.";
    private const string PayloadVersion = "1.2.0";
    private static readonly string LocalRoot = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "BiliSpeechToDocument");
    private static readonly string AppRoot = Path.Combine(LocalRoot, "app");
    private static readonly string RuntimeRoot = Path.Combine(LocalRoot, "runtime");
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(2) };

    private readonly Label _status = new();
    private readonly Label _details = new();
    private readonly TextBox _log = new();
    private readonly Button _openButton = new();
    private readonly Button _retryButton = new();
    private readonly Button _exitButton = new();
    private readonly StringBuilder _processLog = new();
    private readonly object _logLock = new();
    private Process? _node;
    private bool _ownsService;
    private bool _closing;
    private bool _allowClose;

    public LauncherForm()
    {
        Text = "转成文 · 本机服务";
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = true;
        ClientSize = new System.Drawing.Size(560, 350);
        BackColor = System.Drawing.Color.FromArgb(245, 245, 247);
        Font = new System.Drawing.Font("Microsoft YaHei UI", 9F);

        var header = new Panel { Dock = DockStyle.Top, Height = 92, BackColor = System.Drawing.Color.FromArgb(17, 17, 19) };
        var title = new Label
        {
            Text = "转成文",
            ForeColor = System.Drawing.Color.White,
            Font = new System.Drawing.Font("Microsoft YaHei UI", 24F, System.Drawing.FontStyle.Bold),
            AutoSize = true,
            Location = new System.Drawing.Point(24, 12)
        };
        var subtitle = new Label
        {
            Text = "B 站视频 · 本机语音转写 · Word / TXT / SRT",
            ForeColor = System.Drawing.Color.FromArgb(209, 209, 214),
            AutoSize = true,
            Location = new System.Drawing.Point(29, 57)
        };
        header.Controls.Add(title);
        header.Controls.Add(subtitle);
        Controls.Add(header);

        _status.Text = "正在准备本机转写服务…";
        _status.Font = new System.Drawing.Font("Microsoft YaHei UI", 14F, System.Drawing.FontStyle.Bold);
        _status.ForeColor = System.Drawing.Color.FromArgb(17, 17, 19);
        _status.AutoSize = false;
        _status.Location = new System.Drawing.Point(28, 116);
        _status.Size = new System.Drawing.Size(500, 29);
        Controls.Add(_status);

        _details.Text = "第一次启动会解压本机组件，随后自动打开浏览器界面。";
        _details.ForeColor = System.Drawing.Color.FromArgb(110, 110, 115);
        _details.AutoSize = false;
        _details.Location = new System.Drawing.Point(29, 151);
        _details.Size = new System.Drawing.Size(500, 36);
        Controls.Add(_details);

        _log.Multiline = true;
        _log.ReadOnly = true;
        _log.ScrollBars = ScrollBars.Vertical;
        _log.BorderStyle = BorderStyle.FixedSingle;
        _log.BackColor = System.Drawing.Color.White;
        _log.ForeColor = System.Drawing.Color.FromArgb(58, 58, 60);
        _log.Font = new System.Drawing.Font("Consolas", 8.5F);
        _log.Location = new System.Drawing.Point(28, 193);
        _log.Size = new System.Drawing.Size(502, 69);
        Controls.Add(_log);

        _openButton.Text = "打开转写页面";
        _openButton.Enabled = false;
        _openButton.BackColor = System.Drawing.Color.FromArgb(17, 17, 19);
        _openButton.ForeColor = System.Drawing.Color.White;
        _openButton.FlatStyle = FlatStyle.Flat;
        _openButton.FlatAppearance.BorderSize = 0;
        _openButton.Size = new System.Drawing.Size(147, 39);
        _openButton.Location = new System.Drawing.Point(28, 282);
        _openButton.Click += (_, _) => OpenBrowser();
        Controls.Add(_openButton);

        _retryButton.Text = "重试启动";
        _retryButton.Enabled = false;
        _retryButton.Size = new System.Drawing.Size(105, 39);
        _retryButton.Location = new System.Drawing.Point(187, 282);
        _retryButton.Click += async (_, _) => await StartServiceAsync();
        Controls.Add(_retryButton);

        _exitButton.Text = "退出并停止服务";
        _exitButton.Size = new System.Drawing.Size(145, 39);
        _exitButton.Location = new System.Drawing.Point(385, 282);
        _exitButton.Click += (_, _) => Close();
        Controls.Add(_exitButton);

        Shown += async (_, _) => await StartServiceAsync();
        FormClosing += HandleFormClosing;
    }

    private async Task StartServiceAsync()
    {
        if (_closing) return;
        _openButton.Enabled = false;
        _retryButton.Enabled = false;
        SetStatus("正在准备本机转写服务…", "程序组件正在解压，请稍候。", false);
        try
        {
            await Task.Run(ExtractPayload);
            if (await IsServiceReadyAsync())
            {
                _ownsService = false;
                SetStatus("服务已就绪", "本机转写服务正在运行。关闭此窗口不会停止其他启动的服务。", true);
                OpenBrowser();
                return;
            }

            StartNode();
            for (var attempt = 0; attempt < 60; attempt++)
            {
                if (_closing) return;
                if (_node?.HasExited == true)
                {
                    throw new InvalidOperationException("本机服务未能启动。请查看下方日志；也可能是端口 18437 已被占用。\r\n" + RecentLog());
                }
                if (await IsServiceReadyAsync())
                {
                    SetStatus("本机服务已就绪", BackendDescription(), true);
                    OpenBrowser();
                    return;
                }
                await Task.Delay(350);
            }
            throw new InvalidOperationException("等待本机服务超时。请查看下方日志，并确认 FFmpeg 已加入 PATH。\r\n" + RecentLog());
        }
        catch (Exception ex)
        {
            SetStatus("启动没有完成", ex.Message, false);
            _retryButton.Enabled = true;
            if (!string.IsNullOrWhiteSpace(RecentLog())) AppendLog(RecentLog());
        }
    }

    private void StartNode()
    {
        var nodePath = Path.Combine(RuntimeRoot, "node.exe");
        var serverPath = Path.Combine(AppRoot, "server.mjs");
        var start = new ProcessStartInfo
        {
            FileName = nodePath,
            WorkingDirectory = AppRoot,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            WindowStyle = ProcessWindowStyle.Hidden
        };
        start.ArgumentList.Add(serverPath);
        var ffmpeg = FindFfmpeg();
        if (!string.IsNullOrWhiteSpace(ffmpeg)) start.Environment["BILI_TRANSCRIBER_FFMPEG"] = ffmpeg;
        start.Environment["BILI_TRANSCRIBER_PORT"] = "18437";
        var cudaPath = Environment.GetEnvironmentVariable("BILI_TRANSCRIBER_CUDA_DIR");
        var cudaConfig = Path.Combine(LocalRoot, "cuda-path.txt");
        if (string.IsNullOrWhiteSpace(cudaPath) && File.Exists(cudaConfig))
            cudaPath = File.ReadAllText(cudaConfig).Trim();
        if (!string.IsNullOrWhiteSpace(cudaPath) && Directory.Exists(cudaPath))
            start.Environment["BILI_TRANSCRIBER_CUDA_DIR"] = cudaPath;
        _node = new Process { StartInfo = start, EnableRaisingEvents = true };
        _node.OutputDataReceived += (_, e) => { if (!string.IsNullOrWhiteSpace(e.Data)) AppendLog(e.Data); };
        _node.ErrorDataReceived += (_, e) => { if (!string.IsNullOrWhiteSpace(e.Data)) AppendLog(e.Data); };
        _node.Exited += (_, _) =>
        {
            if (!IsDisposed && IsHandleCreated)
                BeginInvoke(new Action(() =>
                {
                    if (!_closing && !_allowClose) SetStatus("本机服务已停止", "可点击“重试启动”重新打开。", false);
                }));
        };
        if (!_node.Start()) throw new InvalidOperationException("Node.js 本机运行时未能启动。");
        _ownsService = true;
        _node.BeginOutputReadLine();
        _node.BeginErrorReadLine();
    }

    private static async Task<bool> IsServiceReadyAsync()
    {
        try
        {
            using var response = await Http.GetAsync(AppUrl + "/api/status");
            if (!response.IsSuccessStatusCode) return false;
            using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            return document.RootElement.TryGetProperty("ok", out var ok) && ok.GetBoolean();
        }
        catch { return false; }
    }

    private async void HandleFormClosing(object? sender, FormClosingEventArgs e)
    {
        if (_allowClose) return;
        e.Cancel = true;
        if (_closing) return;
        _closing = true;
        _exitButton.Enabled = false;
        SetStatus("正在关闭…", "正在停止本机转写服务。", false);
        if (_ownsService)
        {
            try { await Http.PostAsync(AppUrl + "/api/shutdown", null); } catch { }
            try
            {
                if (_node != null && !_node.HasExited)
                {
                    using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(4));
                    await _node.WaitForExitAsync(timeout.Token);
                }
            }
            catch
            {
                try { if (_node != null && !_node.HasExited) _node.Kill(entireProcessTree: true); } catch { }
            }
        }
        _allowClose = true;
        Close();
    }

    private static void ExtractPayload()
    {
        Directory.CreateDirectory(AppRoot);
        Directory.CreateDirectory(RuntimeRoot);
        var versionPath = Path.Combine(LocalRoot, "launcher-version.txt");
        var existingVersion = File.Exists(versionPath) ? File.ReadAllText(versionPath).Trim() : "";
        var appReady = File.Exists(Path.Combine(AppRoot, "server.mjs"));
        if (existingVersion != PayloadVersion || !appReady)
        {
            var archivePath = Path.Combine(LocalRoot, "app-payload.zip");
            WriteResource(ResourceRoot + "app.zip", archivePath, overwrite: true);
            ZipFile.ExtractToDirectory(archivePath, AppRoot, overwriteFiles: true);
            File.Delete(archivePath);
            File.WriteAllText(versionPath, PayloadVersion, Encoding.UTF8);
        }
        var nodePath = Path.Combine(RuntimeRoot, "node.exe");
        if (!File.Exists(nodePath)) WriteResource(ResourceRoot + "node.exe", nodePath, overwrite: false);
    }

    private static void WriteResource(string resourceName, string destination, bool overwrite)
    {
        if (File.Exists(destination) && !overwrite) return;
        using var resource = Assembly.GetExecutingAssembly().GetManifestResourceStream(resourceName)
            ?? throw new InvalidOperationException("EXE 内缺少程序组件：" + resourceName);
        using var output = new FileStream(destination, FileMode.Create, FileAccess.Write, FileShare.None);
        resource.CopyTo(output);
    }

    private static string? FindFfmpeg()
    {
        try
        {
            var start = new ProcessStartInfo("where.exe", "ffmpeg")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            using var process = Process.Start(start);
            if (process == null) return null;
            var output = process.StandardOutput.ReadToEnd();
            process.WaitForExit(2500);
            return output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                .FirstOrDefault(File.Exists);
        }
        catch { return null; }
    }

    private string BackendDescription()
    {
        try
        {
            using var response = Http.GetAsync(AppUrl + "/api/status").GetAwaiter().GetResult();
            using var document = JsonDocument.Parse(response.Content.ReadAsStringAsync().GetAwaiter().GetResult());
            var cuda = document.RootElement.GetProperty("cudaReady").GetBoolean();
            return cuda
                ? "本机转写服务已运行 · 将优先尝试 NVIDIA CUDA，失败时自动回退 CPU。"
                : "本机转写服务已运行 · 使用 CPU 语音识别。";
        }
        catch { return "本机转写服务已运行。"; }
    }

    private void OpenBrowser()
    {
        _openButton.Enabled = true;
        try
        {
            Process.Start(new ProcessStartInfo(AppUrl) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            SetStatus("服务已就绪", "浏览器未能自动打开。点击“打开转写页面”，或访问 " + AppUrl + "。" + ex.Message, true);
        }
    }

    private void SetStatus(string title, string details, bool ready)
    {
        if (IsDisposed) return;
        if (InvokeRequired)
        {
            BeginInvoke(new Action(() => SetStatus(title, details, ready)));
            return;
        }
        _status.Text = title;
        _details.Text = details;
        _openButton.Enabled = ready;
        _retryButton.Enabled = !ready && !_closing;
    }

    private void AppendLog(string line)
    {
        lock (_logLock)
        {
            _processLog.AppendLine(line);
            if (_processLog.Length > 9000) _processLog.Remove(0, _processLog.Length - 7000);
        }
        if (IsDisposed || !IsHandleCreated) return;
        BeginInvoke(new Action(() =>
        {
            _log.Text = RecentLog();
            _log.SelectionStart = _log.TextLength;
            _log.ScrollToCaret();
        }));
    }

    private string RecentLog()
    {
        lock (_logLock) return _processLog.ToString().Trim();
    }
}
