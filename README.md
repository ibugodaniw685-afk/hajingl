# 转成文：B 站视频转文档

Windows 本机转写工具：输入一个 B 站视频链接，在本机获取音轨、用 whisper.cpp 识别语音，再导出 Word、TXT 或 SRT。界面使用黑白灰配色和 iOS 风格圆角卡片。

## 功能

- 支持 BV、av 和 b23.tv 视频链接，以及分 P 链接。
- 长音频按 10 分钟切段，逐段识别并合并时间码。程序没有自设时长上限；总用时取决于 B 站访问权限、网络、磁盘和本机速度。
- 首次运行下载约 148 MB 的 Whisper base 模型，保存在程序 `models` 目录；之后校验并复用。
- 可选 CUDA 版 Whisper；CUDA 不可用时自动回退到 CPU。
- 视频音频、转写任务和导出文件都在本机处理。
- 点“清除本机历史”可删除所有任务进度、字幕段和临时音频；已导出的 Word、TXT、SRT 文件保留。

## 运行源码

要求 Windows、Node.js 20 或更高版本、FFmpeg，并准备以下运行文件：

```text
app/tools/ytdlp/yt-dlp.exe
app/tools/whisper/whisper-cli.exe
app/tools/whisper/whisper.dll
app/tools/whisper/ggml.dll
app/tools/whisper/ggml-base.dll
app/tools/whisper/ggml-cpu.dll
```

这些第三方运行文件不包含在源码仓库中。请从各自上游获取，按 `THIRD-PARTY-NOTICES.md` 保留许可文本。

```powershell
cd app
node server.mjs
```

打开 `http://127.0.0.1:18437`。FFmpeg 必须能从 `PATH` 找到。可将兼容的 CUDA 版 `whisper-cli.exe` 和配套 DLL 放入 `app/tools/cuda`，或设置 `BILI_TRANSCRIBER_CUDA_DIR`。EXE 启动器也会读取 `%LOCALAPPDATA%\BiliSpeechToDocument\cuda-path.txt` 中的可选本机路径。

## 构建单文件 EXE

构建机需要 .NET 6 SDK、Node.js 24.16.0，以及上述 yt-dlp 和 whisper.cpp 运行文件。准备一个资产目录，其中有 `tools/ytdlp` 和 `tools/whisper`，然后运行：

```powershell
.\scripts\build.ps1 `
  -NodeExePath "C:\Program Files\nodejs\node.exe" `
  -AssetsRoot "C:\path\to\runtime-assets"
```

`AssetsRoot` 必须包含 `tools` 文件夹。可在其中加入 `tools/cuda`。脚本生成的 EXE 位于 `build/release/BiliSpeechToDocument.exe`。发布二进制时，请一并提供适用的第三方许可和 .NET 运行时通知。

## 项目结构

- `app/app.html`：本机网页界面。
- `app/server.mjs`：本机 HTTP 服务、视频信息读取、音轨下载、模型缓存、分段转写和文档导出。
- `launcher/`：Windows 启动器源码。
- `scripts/build.ps1`：组装本机运行资产并发布单文件 EXE。
- `licenses/`：第三方许可证文本。

## 隐私与限制

服务只监听 `127.0.0.1`。音频不会上传给 Whisper；但首次下载模型需要联网。任务进度、转写字幕和临时音频会留在本机，直到点“清除本机历史”；导出文件单独保留。需要登录的视频可从当前已登录的 Chrome 或 Edge 读取访问状态。视频能否获取仍由 B 站访问权限决定。

## 许可证

本项目源代码使用 MIT 许可证，见 `LICENSE`。第三方组件遵循各自许可证，见 `THIRD-PARTY-NOTICES.md`。
