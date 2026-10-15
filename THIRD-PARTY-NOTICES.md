# Third-party notices

The repository `LICENSE` applies to this project's own source files only. Third-party components keep their own terms.

- **whisper.cpp / ggml**: MIT. The project requires a user-supplied Windows CLI and DLL set. See [`licenses/whisper.cpp-LICENSE.txt`](licenses/whisper.cpp-LICENSE.txt). Upstream: https://github.com/ggml-org/whisper.cpp
- **yt-dlp**: Unlicense. The project requires a user-supplied executable. See [`licenses/yt-dlp-LICENSE.txt`](licenses/yt-dlp-LICENSE.txt). Its packaged executable may include additional dependencies; preserve [`licenses/yt-dlp-THIRD_PARTY_LICENSES.txt`](licenses/yt-dlp-THIRD_PARTY_LICENSES.txt). Upstream: https://github.com/yt-dlp/yt-dlp
- **Node.js 24.16.0**: MIT plus notices for bundled components. The EXE build embeds a supplied `node.exe`; include [`licenses/Node.js-LICENSE.txt`](licenses/Node.js-LICENSE.txt) when redistributing. Upstream: https://github.com/nodejs/node
- **FFmpeg**: not included. A user-provided PATH installation is required; the applicable license depends on that build's configuration.
- **Whisper model**: downloaded on first use and stored locally. Model files are not included in this source package.
- **.NET desktop runtime**: not included in source. The launcher is built self-contained; compiled redistributions must include applicable runtime and third-party notices for the SDK/runtime used.