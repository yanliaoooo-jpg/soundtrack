/**
 * 声轨 SoundTrace — 后端服务
 * Node.js + Express + ACRCloud
 *
 * 启动前：
 *   1. cp .env.example .env  然后填入你的 ACRCloud 凭证
 *   2. npm install
 *   3. npm start
 */

'use strict';

const express   = require('express');
const multer    = require('multer');
const crypto    = require('crypto');
const FormData  = require('form-data');
const fetch     = require('node-fetch');
const { spawn } = require('child_process');
const path      = require('path');
const fs        = require('fs');
require('dotenv').config();

// ── CONFIG ────────────────────────────────────────────────────────────────────
const PORT       = process.env.PORT       || 3000;
const ACR_HOST   = process.env.ACR_HOST;
const ACR_KEY    = process.env.ACR_KEY;
const ACR_SECRET = process.env.ACR_SECRET;

const SAMPLE_RATE  = 8000;
const SAMPLE_LEN   = 10;
const SCAN_STEP    = 20;
const API_DELAY    = 200;
const MAX_FILE_MB  = parseInt(process.env.MAX_FILE_MB  || '500');
const MAX_DURATION = parseInt(process.env.MAX_DURATION || '10800'); // 3h

// ── EXPRESS ───────────────────────────────────────────────────────────────────
const app    = express();
const upload = multer({
  dest:   path.join(__dirname, 'uploads'),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
});

// Serve the main HTML at root (must be before express.static)
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  fs.createReadStream(path.join(__dirname, '声轨 SoundTrace.html')).pipe(res);
});

// Serve other static assets (CSS, JS, etc.)
app.use(express.static(__dirname));

// ── HELPERS ───────────────────────────────────────────────────────────────────
function acrSign(message) {
  return crypto
    .createHmac('sha1', ACR_SECRET)
    .update(message)
    .digest('base64');
}

/** Wrap raw Int16 PCM buffer in a minimal WAV header */
function pcmToWAV(pcmBuffer) {
  const wav = Buffer.allocUnsafe(44 + pcmBuffer.length);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + pcmBuffer.length, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);  // PCM
  wav.writeUInt16LE(1, 22);  // mono
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(pcmBuffer.length, 40);
  pcmBuffer.copy(wav, 44);
  return wav;
}

/** Use ffmpeg to decode any audio/video file → raw s16le PCM at 8 kHz mono */
function extractPCM(filePath) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const proc = spawn('ffmpeg', [
      '-i', filePath,
      '-vn',           // drop video
      '-f', 's16le',   // raw PCM, 16-bit little-endian
      '-ar', String(SAMPLE_RATE),
      '-ac', '1',      // mono
      'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    proc.stdout.on('data', c => chunks.push(c));

    // Collect stderr for diagnostics (suppressed unless error)
    const errLines = [];
    proc.stderr.on('data', c => errLines.push(c));

    proc.on('close', code => {
      const buf = Buffer.concat(chunks);
      if (buf.length === 0) {
        const errMsg = Buffer.concat(errLines).toString().slice(-500);
        reject(new Error(`ffmpeg 解码失败 (exit ${code}): ${errMsg}`));
      } else {
        resolve(buf);
      }
    });

    proc.on('error', err => {
      reject(new Error('ffmpeg 未安装或无法运行: ' + err.message));
    });
  });
}

/** Call ACRCloud /v1/identify with a WAV buffer, return parsed JSON */
async function acrIdentify(wavBuffer) {
  const timestamp    = Math.floor(Date.now() / 1000);
  const dataType     = 'audio';
  const sigVersion   = '1';
  const stringToSign = `POST\n/v1/identify\n${ACR_KEY}\n${dataType}\n${sigVersion}\n${timestamp}`;
  const signature    = acrSign(stringToSign);

  const form = new FormData();
  form.append('access_key',        ACR_KEY);
  form.append('sample',            wavBuffer, { filename: 'sample.wav', contentType: 'audio/wav' });
  form.append('sample_bytes',      wavBuffer.length);
  form.append('timestamp',         timestamp);
  form.append('signature',         signature);
  form.append('data_type',         dataType);
  form.append('signature_version', sigVersion);

  const resp = await fetch(`https://${ACR_HOST}/v1/identify`, {
    method:  'POST',
    body:    form,
    headers: form.getHeaders(),
    timeout: 15000,
  });

  if (!resp.ok) throw new Error(`ACRCloud HTTP ${resp.status}`);
  return resp.json();
}

/** Extract PCM from a video/audio URL via yt-dlp → ffmpeg pipe (no temp file) */
function extractPCMFromURL(url) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    // yt-dlp writes raw audio to stdout; ffmpeg reads from stdin and outputs PCM
    const ytdlp = spawn('yt-dlp', [
      '--no-playlist',
      '-f', 'bestaudio/best',
      '-o', '-',          // output to stdout
      '--quiet',
      url,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const ffmpeg = spawn('ffmpeg', [
      '-i', 'pipe:0',     // read from stdin
      '-vn',
      '-f', 's16le',
      '-ar', String(SAMPLE_RATE),
      '-ac', '1',
      'pipe:1',           // write PCM to stdout
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    ytdlp.stdout.pipe(ffmpeg.stdin);

    // yt-dlp errors → useful messages
    const ytErr = [];
    ytdlp.stderr.on('data', c => ytErr.push(c));
    ytdlp.on('close', code => {
      if (code !== 0) {
        ffmpeg.kill();
        const msg = Buffer.concat(ytErr).toString().slice(-400);
        reject(new Error(`yt-dlp 失败 (${code}): ${msg}`));
      }
    });

    ffmpeg.stdout.on('data', c => chunks.push(c));
    const ffErr = [];
    ffmpeg.stderr.on('data', c => ffErr.push(c));

    ffmpeg.on('close', code => {
      const buf = Buffer.concat(chunks);
      if (buf.length === 0) {
        const msg = Buffer.concat(ffErr).toString().slice(-400);
        reject(new Error(`ffmpeg 解码失败 (${code}): ${msg}`));
      } else {
        resolve(buf);
      }
    });

    ytdlp.on('error', e => reject(new Error('yt-dlp 未安装: ' + e.message)));
    ffmpeg.on('error', e => reject(new Error('ffmpeg 未安装: ' + e.message)));
  });
}

/** Shared scan loop: takes PCM buffer, streams results via SSE send() */
async function runScan(pcm, send) {
  const bytesPerSample = 2;
  const totalSamples   = pcm.length / bytesPerSample;
  const totalSeconds   = totalSamples / SAMPLE_RATE;
  const chunkBytes     = SAMPLE_RATE * bytesPerSample * SAMPLE_LEN;
  const stepBytes      = SAMPLE_RATE * bytesPerSample * SCAN_STEP;
  const totalSteps     = Math.max(1, Math.ceil(totalSeconds / SCAN_STEP));

  send('meta', {
    duration: totalSeconds,
    steps:    totalSteps,
    msg:      `时长 ${Math.round(totalSeconds)}s，分 ${totalSteps} 段识别`,
  });

  const seen = new Map();
  let found  = 0;
  let errors = 0;
  const MAX_ERRORS = 5;

  for (let i = 0; i < totalSteps; i++) {
    const tSec   = i * SCAN_STEP;
    const offset = i * stepBytes;
    const slice  = pcm.slice(offset, offset + chunkBytes);
    if (slice.length < bytesPerSample) continue;

    const pct = Math.round(((i + 1) / totalSteps) * 100);
    send('progress', {
      step:  i + 1,
      total: totalSteps,
      pct,
      t:     tSec,
      msg:   `第 ${i + 1}/${totalSteps} 段（${formatTime(tSec)}）`,
    });

    try {
      const result = await acrIdentify(pcmToWAV(slice));
      if (result?.metadata?.music?.length) {
        for (const m of result.metadata.music) {
          const key = `${(m.title || '').toLowerCase()}||${((m.artists || [])[0]?.name || '').toLowerCase()}`;
          if (seen.has(key)) continue;
          seen.set(key, true);
          found++;
          send('song', {
            start:        parseFloat(tSec.toFixed(1)),
            end:          parseFloat(Math.min(totalSeconds, tSec + SCAN_STEP).toFixed(1)),
            title:        m.title        || '未知歌曲',
            artist:       (m.artists || []).map(a => a.name).join(', ') || '未知',
            album:        m.album?.name  || '',
            label:        m.label        || '',
            release_date: m.release_date || '',
            score:        m.score        || 0,
            isrc:         m.external_ids?.isrc || '—',
            acrid:        m.acrid        || '',
          });
        }
      }
    } catch (e) {
      errors++;
      send('warn', { msg: `第 ${i + 1} 段识别失败：${e.message}` });
      if (errors >= MAX_ERRORS) {
        send('error', { msg: '连续失败次数过多，终止扫描。请检查凭证或网络。' });
        return { found, totalSeconds };
      }
    }

    if (i < totalSteps - 1) await new Promise(r => setTimeout(r, API_DELAY));
  }

  return { found, totalSeconds };
}

/** Start SSE response and return send helper */
function startSSE(res) {
  res.writeHead(200, {
    'Content-Type':      'text/event-stream; charset=utf-8',
    'Cache-Control':     'no-cache',
    'Connection':        'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  return (type, payload = {}) => res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
}

function checkACR(res) {
  if (!ACR_HOST || !ACR_KEY || !ACR_SECRET) {
    res.status(500).json({ error: '服务器未配置 ACRCloud 凭证，请检查 .env 文件' });
    return false;
  }
  return true;
}

// ── /api/scan  — 本地文件上传 ─────────────────────────────────────────────────
app.post('/api/scan', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未收到文件' });
  if (!checkACR(res)) { fs.unlink(req.file.path, () => {}); return; }

  const send     = startSSE(res);
  const filePath = req.file.path;

  try {
    send('status', { msg: '正在解码音频（ffmpeg）…' });
    const pcm = await extractPCM(filePath);
    const { found, totalSeconds } = await runScan(pcm, send);
    send('done', { found, duration: totalSeconds });
  } catch (e) {
    console.error('Scan error:', e);
    send('error', { msg: e.message });
  } finally {
    fs.unlink(filePath, () => {});
    res.end();
  }
});

// ── /api/scan-url  — 链接识别（YouTube / 抖音 / B站 等）────────────────────────
app.post('/api/scan-url', express.json(), async (req, res) => {
  const url = (req.body?.url || '').trim();
  if (!url) return res.status(400).json({ error: '未提供链接' });
  if (!checkACR(res)) return;

  const send = startSSE(res);

  try {
    send('status', { msg: `正在下载音频：${url.slice(0, 60)}…` });
    const pcm = await extractPCMFromURL(url);
    const { found, totalSeconds } = await runScan(pcm, send);
    send('done', { found, duration: totalSeconds });
  } catch (e) {
    console.error('URL scan error:', e);
    send('error', { msg: e.message });
  } finally {
    res.end();
  }
});

// ── UTILS ─────────────────────────────────────────────────────────────────────
function formatTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

// ── START ─────────────────────────────────────────────────────────────────────
// Create uploads dir if needed
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

app.listen(PORT, () => {
  console.log('');
  console.log('  声轨 SoundTrace');
  console.log(`  http://localhost:${PORT}`);
  console.log('');
  console.log('  ACRCloud Host  :', ACR_HOST   || '⚠  未配置 (ACR_HOST)');
  console.log('  ACRCloud Key   :', ACR_KEY    ? '✓ 已配置' : '⚠  未配置 (ACR_KEY)');
  console.log('  ACRCloud Secret:', ACR_SECRET ? '✓ 已配置' : '⚠  未配置 (ACR_SECRET)');
  console.log('');
});
