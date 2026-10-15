import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { deflateRawSync } from 'node:zlib';

const root = dirname(fileURLToPath(import.meta.url));
const host = '127.0.0.1';
const port = Number(process.env.BILI_TRANSCRIBER_PORT || 18437);
const appUrl = `http://${host}:${port}`;
const dataDir = join(root, 'data', 'jobs');
const exportDir = join(root, 'exports');
const modelPath = join(root, 'models', 'ggml-base.bin');
const modelUrl = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/80da2d8bfee42b0e836fc3a9890373e5defc00a6/ggml-base.bin?download=true';
const modelSize = 147951465;
const modelSha256 = '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe';
const ytdlpPath = join(root, 'tools', 'ytdlp', 'yt-dlp.exe');
const cpuWhisperPath = join(root, 'tools', 'whisper', 'whisper-cli.exe');
const cudaCandidates = [
  process.env.BILI_TRANSCRIBER_CUDA_DIR,
  join(root, 'tools', 'cuda')
].filter(Boolean);
const cudaDir = cudaCandidates.find((path) => existsSync(join(path, 'whisper-cli.exe')));
const cudaWhisperPath = cudaDir ? join(cudaDir, 'whisper-cli.exe') : '';
const ffmpegPath = process.env.BILI_TRANSCRIBER_FFMPEG || 'ffmpeg';
const chunkSeconds = 10 * 60;
const threadCount = Math.max(2, Math.min(8, cpus().length - 1 || 2));
const jobs = new Map();
let activeJob = null;
let activeChild = null;
let modelPromise = null;
let shuttingDown = false;

function error(message, status = 400) {
  const result = new Error(message);
  result.status = status;
  return result;
}

function localRequest(req) {
  const remote = req.socket.remoteAddress || '';
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote) && req.headers.host === `${host}:${port}`;
}

function validBiliUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch (_) { throw error('请粘贴完整的 B 站视频链接。'); }
  const domain = url.hostname.toLowerCase();
  const validHost = domain === 'b23.tv' || domain === 'bilibili.com' || domain.endsWith('.bilibili.com');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !validHost) {
    throw error('只接受 bilibili.com 或 b23.tv 的视频链接。');
  }
  return url.toString();
}

function cookieArgs(browser) {
  if (browser === 'chrome' || browser === 'edge') return ['--cookies-from-browser', browser];
  return [];
}

function safeName(value) {
  return String(value || 'B站视频转写').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/[. ]+$/g, '').trim().slice(0, 120) || 'B站视频转写';
}

function statusView(job) {
  if (!job) return null;
  return {
    id: job.id,
    phase: job.phase,
    percent: job.percent,
    message: job.message,
    title: job.title || '',
    duration: job.duration || 0,
    chunksDone: job.chunksDone || 0,
    chunksTotal: job.chunksTotal || 0,
    backend: job.backend || (cudaWhisperPath ? 'NVIDIA CUDA' : 'CPU'),
    state: job.state,
    error: job.error || '',
    sourceUrl: job.sourceUrl || '',
    updatedAt: job.updatedAt || ''
  };
}

async function persistJob(job) {
  job.updatedAt = new Date().toISOString();
  await writeFile(join(job.dir, 'job-state.json'), JSON.stringify({
    ...statusView(job),
    segments: job.segments || []
  }), 'utf8');
}

async function loadJob(id) {
  if (!/^[a-f0-9-]{12,50}$/i.test(String(id || ''))) return null;
  if (jobs.has(id)) return jobs.get(id);
  try {
    const dir = join(dataDir, id);
    const value = JSON.parse(await readFile(join(dir, 'job-state.json'), 'utf8'));
    const job = { ...value, dir };
    jobs.set(id, job);
    return job;
  } catch (_) { return null; }
}

async function runTool(executable, args, { cwd = root, onLine = () => {}, captureStdout = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    let output = '';
    let tail = '';
    let pending = '';
    let settled = false;
    let child;
    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      if (activeChild === child) activeChild = null;
      err ? reject(err) : resolvePromise(result);
    };
    try {
      child = spawn(executable, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      activeChild = child;
      child.stdout.on('data', (chunk) => {
        if (!captureStdout) return;
        output += chunk.toString('utf8');
        if (output.length > 64 * 1024 * 1024) {
          try { child.kill(); } catch (_) {}
          finish(error('视频信息返回过大，已停止读取。', 502));
        }
      });
      child.stderr.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        tail = (tail + text).slice(-5000);
        pending += text;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() || '';
        for (const line of lines) onLine(line);
      });
      child.once('error', (err) => finish(error(err.code === 'ENOENT' ? `找不到本机组件：${basename(executable)}。请检查 README 中的依赖设置。` : '本机组件无法启动。', 503)));
      child.once('close', (code) => {
        if (pending) onLine(pending);
        if (activeJob?.cancelRequested) return finish(error('任务已取消。', 499));
        if (code === 0) return finish(null, { stdout: output, stderr: tail });
        finish(error(toolFailureMessage(executable, tail, code), 422));
      });
    } catch (_) {
      finish(error('本机组件无法启动。', 503));
    }
  });
}

function toolFailureMessage(executable, detail, code) {
  const lower = `${executable} ${detail}`.toLowerCase();
  if (/sign in|login|cookies|private|geo.?block|403|412/.test(lower)) return 'B 站没有向本机提供这段视频的音轨。它可能需要登录、受地域限制或暂时无法访问；可在上方选择已登录的 Chrome 或 Edge 后重试。';
  if (/cublas|cuda|ggml-cuda|nvcuda|cudart/.test(lower)) return 'CUDA 初始化失败，正在尝试 CPU 回退。';
  if (String(executable).toLowerCase().includes('ffmpeg')) return '音频切段失败。请确认 FFmpeg 可在命令行运行，再重试。';
  if (String(executable).toLowerCase().includes('yt-dlp')) return 'B 站音频获取失败。请确认链接可播放；若需要登录，选择已登录的浏览器后重试。';
  return `本机语音识别失败（退出码 ${code}）。请检查模型文件或切换到 CPU 后重试。`;
}

function update(job, values) {
  Object.assign(job, values, { updatedAt: new Date().toISOString() });
}

async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function ensureModel(job) {
  if (modelPromise) return modelPromise;
  modelPromise = downloadModel(job).finally(() => { modelPromise = null; });
  return modelPromise;
}

async function downloadModel(job) {
  await mkdir(dirname(modelPath), { recursive: true });
  try {
    const info = await stat(modelPath);
    if (info.size === modelSize && await fileHash(modelPath) === modelSha256) return modelPath;
  } catch (_) {}
  const temporary = `${modelPath}.download-${process.pid}`;
  await rm(temporary, { force: true }).catch(() => {});
  update(job, { phase: '准备语音模型', percent: 4, message: '首次使用：正在下载约 148 MB 的本机语音模型' });
  let response;
  try {
    response = await fetch(modelUrl, { signal: AbortSignal.timeout(30 * 60 * 1000) });
  } catch (err) {
    const reason = err.cause?.message || err.message || '网络连接失败';
    throw error(`语音模型下载失败：${reason}。请检查网络或代理设置后重试。`, 503);
  }
  if (!response.ok || !response.body) throw error(`语音模型下载失败（HTTP ${response.status}）。检查网络后重试。`, 503);
  const hash = createHash('sha256');
  let received = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > modelSize) return callback(error('语音模型文件大小不符，已停止下载。', 502));
      hash.update(chunk);
      job.percent = Math.min(7, 4 + received / modelSize * 3);
      callback(null, chunk);
    }
  });
  try {
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(temporary, { flags: 'wx' }));
    if (received !== modelSize || hash.digest('hex') !== modelSha256) throw error('语音模型校验失败。请检查网络后重试。', 502);
    await rm(modelPath, { force: true }).catch(() => {});
    await rename(temporary, modelPath);
    return modelPath;
  } catch (err) {
    await rm(temporary, { force: true }).catch(() => {});
    throw err.status ? err : error('语音模型下载中断。检查网络后重试。', 503);
  }
}

function parseTimestamp(value) {
  const match = String(value).trim().match(/^(\d{2,}):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

function parseSrt(text, offset = 0) {
  return String(text).replace(/\r/g, '').split(/\n{2,}/).map((block) => {
    const lines = block.split('\n');
    const index = lines.findIndex((line) => line.includes('-->'));
    if (index < 0) return null;
    const times = lines[index].split('-->').map((part) => part.trim());
    const from = parseTimestamp(times[0]);
    const to = parseTimestamp(times[1]);
    const content = lines.slice(index + 1).join(' ').trim();
    if (from === null || !content) return null;
    return { from: from + offset, to: (to ?? from) + offset, content: content.slice(0, 2000) };
  }).filter(Boolean);
}

function formatTime(value, srt = false) {
  const ms = Math.max(0, Math.round(Number(value || 0) * 1000));
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor(ms % 3600000 / 60000);
  const seconds = Math.floor(ms % 60000 / 1000);
  const millis = ms % 1000;
  const base = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${base}${srt ? ',' : ':'}${String(millis).padStart(3, '0')}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '时长未知';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor(total % 3600 / 60);
  const s = total % 60;
  return h ? `${h}小时${m}分${s}秒` : `${m}分${s}秒`;
}

function xmlText(value) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStore(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  const stamp = new Date();
  const dosTime = (stamp.getHours() << 11) | (stamp.getMinutes() << 5) | Math.floor(stamp.getSeconds() / 2);
  const dosDate = ((Math.max(1980, stamp.getFullYear()) - 1980) << 9) | ((stamp.getMonth() + 1) << 5) | stamp.getDate();
  for (const [name, rawValue] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const raw = Buffer.isBuffer(rawValue) ? rawValue : Buffer.from(rawValue, 'utf8');
    const packed = deflateRawSync(raw, { level: 6 });
    const crc = crc32(raw);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(8, 8); header.writeUInt16LE(dosTime, 10); header.writeUInt16LE(dosDate, 12);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(packed.length, 18); header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    local.push(header, nameBytes, packed);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x0800, 8); directory.writeUInt16LE(8, 10); directory.writeUInt16LE(dosTime, 12); directory.writeUInt16LE(dosDate, 14);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(packed.length, 20); directory.writeUInt32LE(raw.length, 24);
    directory.writeUInt16LE(nameBytes.length, 28); directory.writeUInt32LE(0, 38); directory.writeUInt32LE(offset, 42);
    central.push(directory, nameBytes);
    offset += header.length + nameBytes.length + packed.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

function docxBuffer(job) {
  const meta = [
    `视频来源：${job.sourceUrl}`,
    `视频时长：${formatDuration(job.duration)}`,
    `转写方式：${job.backend} · Whisper 本机语音识别`,
    `生成时间：${new Date(job.updatedAt || Date.now()).toLocaleString('zh-CN')}`
  ];
  const paragraphs = [
    `<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t xml:space="preserve">${xmlText(job.title || 'B站视频转写')}</w:t></w:r></w:p>`,
    ...meta.map((line) => `<w:p><w:pPr><w:pStyle w:val="Subtitle"/></w:pPr><w:r><w:t xml:space="preserve">${xmlText(line)}</w:t></w:r></w:p>`),
    '<w:p><w:r><w:br w:type="page"/></w:r></w:p>',
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>语音转写</w:t></w:r></w:p>',
    ...(job.segments || []).map((segment) => `<w:p><w:pPr><w:spacing w:after="120"/></w:pPr><w:r><w:rPr><w:color w:val="52716B"/><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">${xmlText(formatTime(segment.from))}  </w:t></w:r><w:r><w:t xml:space="preserve">${xmlText(segment.content)}</w:t></w:r></w:p>`)
  ].join('');
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const stylesXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:eastAsia="等线"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:b/><w:color w:val="193B37"/><w:sz w:val="36"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:rPr><w:color w:val="667975"/><w:sz w:val="18"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:qFormat/><w:rPr><w:b/><w:color w:val="193B37"/><w:sz w:val="28"/></w:rPr></w:style></w:styles>';
  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>';
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>';
  const documentRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>';
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlText(job.title || 'B站视频转写')}</dc:title><dc:creator>B站视频转文档</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created></cp:coreProperties>`;
  return zipStore([
    ['[Content_Types].xml', contentTypes],
    ['_rels/.rels', rels],
    ['docProps/core.xml', core],
    ['word/document.xml', documentXml],
    ['word/styles.xml', stylesXml],
    ['word/_rels/document.xml.rels', documentRels]
  ]);
}

function transcriptText(job) {
  return `${job.title || 'B站视频转写'}\n来源：${job.sourceUrl}\n时长：${formatDuration(job.duration)}\n转写方式：${job.backend} · Whisper 本机语音识别\n\n${(job.segments || []).map((segment) => `${formatTime(segment.from)}  ${segment.content}`).join('\n')}\n`;
}

function transcriptSrt(job) {
  return (job.segments || []).map((segment, index) => `${index + 1}\n${formatTime(segment.from, true)} --> ${formatTime(segment.to, true)}\n${segment.content}`).join('\n\n') + '\n';
}

async function exportJob(job, format) {
  const extension = format === 'docx' ? 'docx' : format === 'srt' ? 'srt' : 'txt';
  const filename = `${safeName(job.title)}.${extension}`;
  const fullPath = join(exportDir, filename);
  let bytes;
  if (format === 'docx') bytes = docxBuffer(job);
  else if (format === 'srt') bytes = Buffer.from(transcriptSrt(job), 'utf8');
  else bytes = Buffer.from(transcriptText(job), 'utf8');
  await mkdir(exportDir, { recursive: true });
  await writeFile(fullPath, bytes);
  return { filename, fullPath, bytes };
}

async function transcribeChunk(job, wavPath, prefix, offset) {
  const args = ['-m', modelPath, '-f', wavPath, '-l', job.language || 'auto', '-t', String(threadCount), '-osrt', '-of', prefix, '-np'];
  const run = async (exe, cwd, backend) => {
    update(job, { message: `${job.message.split('（')[0]}（${backend}）` });
    let lastReported = 0;
    await runTool(exe, args, {
      cwd,
      onLine: (line) => {
        const match = line.match(/progress\s*=\s*(\d+)%/i);
        if (match) lastReported = Number(match[1]);
        const inner = job.chunksTotal ? (job.chunksDone + lastReported / 100) / job.chunksTotal : 0;
        job.percent = Math.min(96, 42 + inner * 52);
      }
    });
  };
  if (job.backend === 'NVIDIA CUDA' && cudaWhisperPath) {
    try { await run(cudaWhisperPath, cudaDir, 'NVIDIA CUDA'); }
    catch (err) {
      if (job.cancelRequested || !existsSync(cpuWhisperPath)) throw err;
      update(job, { backend: 'CPU', message: 'CUDA 初始化失败，已回退 CPU；正在识别当前分段' });
      await persistJob(job);
      await run(cpuWhisperPath, dirname(cpuWhisperPath), 'CPU');
    }
  } else {
    await run(cpuWhisperPath, dirname(cpuWhisperPath), 'CPU');
  }
  const srtPath = `${prefix}.srt`;
  const srt = await readFile(srtPath, 'utf8');
  await rm(srtPath, { force: true });
  return parseSrt(srt, offset);
}

async function executeJob(job, input) {
  const jobDir = job.dir;
  const chunksDir = join(jobDir, 'chunks');
  let sourcePath = '';
  try {
    update(job, { phase: '读取视频信息', percent: 3, message: '正在读取 B 站视频信息' });
    const url = validBiliUrl(input.url);
    const cookies = cookieArgs(input.browser);
    const metadataResult = await runTool(ytdlpPath, ['--no-warnings', '--no-playlist', '--dump-single-json', '--skip-download', ...cookies, url], { captureStdout: true, cwd: dirname(ytdlpPath) });
    let metadata;
    try { metadata = JSON.parse(metadataResult.stdout.trim()); }
    catch (_) { throw error('B 站视频信息无法解析，请确认链接指向单个视频页面。', 422); }
    job.title = String(metadata.title || metadata.fulltitle || 'B站视频转写').slice(0, 500);
    job.duration = Number(metadata.duration || 0);
    job.sourceUrl = url;
    await persistJob(job);

    await ensureModel(job);

    update(job, { phase: '获取音轨', percent: 8, message: '正在从 B 站获取音轨；音频只保存在本机' });
    await runTool(ytdlpPath, ['--no-warnings', '--no-playlist', '--newline', '--progress', '--format', 'bestaudio/best', '--output', join(jobDir, 'source.%(ext)s'), ...cookies, url], {
      cwd: dirname(ytdlpPath),
      onLine: (line) => {
        const match = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
        if (match) {
          const downloaded = Math.max(0, Math.min(100, Number(match[1])));
          job.percent = 8 + downloaded * 0.27;
          job.message = `正在获取 B 站音轨 · ${downloaded.toFixed(1)}%`;
        }
      }
    });
    const sourceName = (await readdir(jobDir)).find((name) => name.startsWith('source.') && !name.endsWith('.part'));
    if (!sourceName) throw error('B 站没有返回可处理的音轨。', 422);
    sourcePath = join(jobDir, sourceName);
    const audioBytes = (await stat(sourcePath)).size;

    await mkdir(chunksDir, { recursive: true });
    const expectedChunks = job.duration > 0 ? Math.ceil(job.duration / chunkSeconds) : 0;
    update(job, { phase: '切分音频', percent: 36, chunksTotal: expectedChunks, message: '正在按 10 分钟切分音频' });
    await runTool(ffmpegPath, [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-stats_period', '1', '-progress', 'pipe:2',
      '-i', sourcePath, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
      '-f', 'segment', '-segment_time', String(chunkSeconds), '-reset_timestamps', '1', join(chunksDir, 'chunk-%06d.wav')
    ], {
      cwd: root,
      onLine: (line) => {
        const match = line.match(/^out_time_(?:us|ms)=(\d+)/);
        if (match && job.duration > 0) {
          const seconds = Number(match[1]) / (line.includes('_us=') ? 1_000_000 : 1_000_000);
          job.percent = Math.min(41, 36 + seconds / job.duration * 5);
          job.message = `正在切分音频 · ${Math.min(100, Math.floor(seconds / job.duration * 100))}%`;
        }
      }
    });
    await rm(sourcePath, { force: true });
    sourcePath = '';
    const chunkCandidates = (await readdir(chunksDir)).filter((name) => /^chunk-\d+\.wav$/i.test(name)).sort();
    const chunks = [];
    for (const name of chunkCandidates) if ((await stat(join(chunksDir, name))).size > 44) chunks.push(name);
    if (!chunks.length) throw error('音频切分后没有得到可识别的片段。', 422);
    job.chunksTotal = chunks.length;
    update(job, { phase: '本机语音识别', percent: 42, message: `正在本机识别第 1/${chunks.length} 段` });
    for (let index = 0; index < chunks.length; index++) {
      if (job.cancelRequested) throw error('任务已取消。', 499);
      const chunkPath = join(chunksDir, chunks[index]);
      const prefix = join(chunksDir, `text-${String(index).padStart(6, '0')}`);
      update(job, { phase: '本机语音识别', message: `正在本机识别第 ${index + 1}/${chunks.length} 段` });
      const segments = await transcribeChunk(job, chunkPath, prefix, index * chunkSeconds);
      job.segments.push(...segments);
      job.chunksDone = index + 1;
      job.percent = Math.min(97, 42 + job.chunksDone / chunks.length * 54);
      await rm(chunkPath, { force: true });
      await persistJob(job);
    }
    if (!job.segments.length) throw error('没有识别到可用语音文字。视频可能没有语音，或音频质量过低。', 422);
    await rm(chunksDir, { recursive: true, force: true });
    update(job, { state: 'completed', phase: '已完成', percent: 100, message: `转写完成，共 ${job.segments.length.toLocaleString('zh-CN')} 条时间段`, error: '' });
    await persistJob(job);
  } catch (err) {
    const cancelled = job.cancelRequested || err.status === 499;
    update(job, { state: cancelled ? 'cancelled' : 'failed', phase: cancelled ? '已取消' : '转写失败', percent: job.percent ?? 0, message: cancelled ? '任务已取消' : '转写没有完成', error: cancelled ? '' : (err.message || '处理失败') });
    await persistJob(job).catch(() => {});
  } finally {
    if (sourcePath) await rm(sourcePath, { force: true }).catch(() => {});
    if (job.state !== 'completed') await rm(chunksDir, { recursive: true, force: true }).catch(() => {});
    if (activeJob?.id === job.id) activeJob = null;
    activeChild = null;
  }
}

async function fileExists(path) {
  try { await access(path); return true; } catch (_) { return false; }
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 50000) throw error('请求内容过大。', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch (_) { throw error('请求内容格式无效。'); }
}

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
}

const server = http.createServer(async (req, res) => {
  if (!localRequest(req)) return json(res, 403, { ok: false, error: '本工具仅接受本机连接。' });
  const url = new URL(req.url, appUrl);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return res.end(await readFile(join(root, 'app.html')));
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      let job = activeJob;
      if (!activeJob && url.searchParams.get('id')) job = await loadJob(url.searchParams.get('id'));
      return json(res, 200, {
        ok: true,
        busy: Boolean(activeJob),
        job: statusView(job),
        backend: cudaWhisperPath ? 'NVIDIA CUDA' : 'CPU',
        cudaReady: Boolean(cudaWhisperPath),
        toolsReady: existsSync(ytdlpPath) && existsSync(cpuWhisperPath),
        modelReady: await fileExists(modelPath)
      });
    }
    if (req.method === 'DELETE' && url.pathname === '/api/history') {
      if (activeJob?.state === 'running') return json(res, 409, { ok: false, error: '转写仍在进行，完成或取消后再清除历史。' });
      const entries = await readdir(dataDir, { withFileTypes: true });
      const historyDirs = entries.filter((entry) => entry.isDirectory() && /^[a-f0-9-]{12,50}$/i.test(entry.name));
      for (const entry of historyDirs) await rm(join(dataDir, entry.name), { recursive: true, force: true });
      jobs.clear();
      activeJob = null;
      return json(res, 200, { ok: true, removed: historyDirs.length });
    }
    if (req.method === 'POST' && url.pathname === '/api/transcribe') {
      if (activeJob) return json(res, 409, { ok: false, error: '已有转写任务正在运行，请等待完成或取消。' });
      const input = await readBody(req);
      const sourceUrl = validBiliUrl(input.url);
      const jobId = `${Date.now().toString(16)}-${cryptoRandom()}`;
      const jobDir = join(dataDir, jobId);
      await mkdir(jobDir, { recursive: true });
      const language = ['auto', 'zh', 'en', 'ja', 'ko'].includes(input.language) ? input.language : 'auto';
      const job = { id: jobId, dir: jobDir, state: 'running', phase: '准备中', percent: 1, message: '正在准备任务', title: '', duration: 0, chunksDone: 0, chunksTotal: 0, backend: cudaWhisperPath ? 'NVIDIA CUDA' : 'CPU', language, segments: [], error: '', sourceUrl, updatedAt: new Date().toISOString() };
      jobs.set(jobId, job);
      activeJob = job;
      await persistJob(job);
      void executeJob(job, { ...input, url: sourceUrl });
      return json(res, 202, { ok: true, job: statusView(job) });
    }
    if (req.method === 'POST' && url.pathname === '/api/cancel') {
      if (!activeJob) return json(res, 200, { ok: true });
      activeJob.cancelRequested = true;
      activeJob.message = '正在停止当前步骤…';
      try { activeChild?.kill(); } catch (_) {}
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/shutdown') {
      json(res, 200, { ok: true });
      setTimeout(shutdownService, 150);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/download') {
      const job = await loadJob(url.searchParams.get('id'));
      if (!job || job.state !== 'completed') return json(res, 404, { ok: false, error: '找不到已完成的转写结果。' });
      const format = url.searchParams.get('format') || 'docx';
      if (!['docx', 'txt', 'srt'].includes(format)) return json(res, 400, { ok: false, error: '不支持的文档格式。' });
      const file = await exportJob(job, format);
      const type = format === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'text/plain; charset=utf-8';
      res.writeHead(200, { 'content-type': type, 'content-length': file.bytes.length, 'content-disposition': `attachment; filename="transcript.${format}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`, 'cache-control': 'no-store', 'x-export-path': encodeURIComponent(file.fullPath) });
      return res.end(file.bytes);
    }
    json(res, 404, { ok: false, error: '没有这个本机接口。' });
  } catch (err) {
    if (!res.writableEnded) json(res, err.status || 400, { ok: false, error: err.message || '请求失败。' });
  }
});

function shutdownService() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (activeJob) activeJob.cancelRequested = true;
  try { activeChild?.kill(); } catch (_) {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1800).unref();
}

function cryptoRandom() {
  return createHash('sha1').update(`${Date.now()}-${Math.random()}-${process.pid}`).digest('hex').slice(0, 18);
}

await mkdir(dataDir, { recursive: true });
await mkdir(exportDir, { recursive: true });
server.listen(port, host, () => {
  console.log(`B站视频转文档已启动：${appUrl}`);
  console.log(`语音识别：${cudaWhisperPath ? 'NVIDIA CUDA（可用时）' : 'CPU'}；无 CUDA 时自动用 CPU`);
  console.log('关闭此窗口即可停止本机服务。');
});
process.on('SIGTERM', shutdownService);
process.on('SIGINT', shutdownService);
