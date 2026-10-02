import { FFmpeg } from './vendor/ffmpeg/index.js';

// ffmpeg core (single-threaded, no special headers needed). Pinned so the exact size is known.
const CORE_BASE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';
const CORE_WASM_BYTES = 32232419;

const TARGET_BYTES = 18e6;   // aim for ~18 MB
const MAX_BYTES = 20e6;      // never exceed 20 MB
const AUDIO_BPS = 128e3;
const MIN_BPP = 0.06;        // below this many bits/pixel/frame, downscale instead of starving quality
const MIN_HEIGHT = 360;
const MIN_CLIP = 0.5;
const MAX_ATTEMPTS = 5;

const $ = (id) => document.getElementById(id);
const drop = $('drop'), fileInput = $('file'), dropError = $('dropError');
const editor = $('editor'), stage = $('stage'), video = $('video');
const cropEl = $('crop'), cropSize = $('cropSize'), cropBtn = $('cropBtn');
const playBtn = $('play'), track = $('track'), range = $('range');
const hStart = $('hStart'), hEnd = $('hEnd'), playhead = $('playhead'), clock = $('clock');
const startIn = $('start'), endIn = $('end'), len = $('len');
const exportBtn = $('export'), statusEl = $('status'), statusText = $('statusText');
const bar = statusEl.querySelector('.bar'), barFill = $('barFill'), cancelBtn = $('cancel');
const resultEl = $('result'), resultInfo = $('resultInfo'), download = $('download'), another = $('another');

let file = null;
let duration = 0, selStart = 0, selEnd = 0;
let cropOn = false;
let crop = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }; // normalized to the source frame
let busy = false;
let job = 0; // bumped on every export/cancel so stale work can tell it was abandoned
let resultURL = null;

/* ---------------- helpers ---------------- */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round1 = (t) => Math.round(t * 10) / 10;
const even = (n) => Math.max(2, Math.floor(n / 2) * 2);

function fmt(t) {
  t = round1(t);
  const m = Math.floor(t / 60);
  const s = round1(t - m * 60);
  const ss = Number.isInteger(s) ? String(s).padStart(2, '0') : s.toFixed(1).padStart(4, '0');
  return `${String(m).padStart(2, '0')}:${ss}`;
}

function fmtLen(d) {
  d = round1(d);
  return d < 60 ? `${d} sec` : fmt(d);
}

function parseTime(str) {
  const parts = str.trim().split(':');
  if (!parts.length || parts.length > 3 || parts.some((p) => p === '' || isNaN(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + parseFloat(p), 0);
}

/* ---------------- loading a video ---------------- */

$('choose').onclick = () => fileInput.click();
fileInput.onchange = () => openFile(fileInput.files[0]);
another.onclick = () => fileInput.click();

window.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) drop.classList.remove('over'); });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  openFile(e.dataTransfer.files[0]);
});

function openFile(f) {
  if (!f || busy) return;
  file = f;
  fileInput.value = '';
  dropError.hidden = true;
  statusEl.hidden = resultEl.hidden = true;
  if (video.src) URL.revokeObjectURL(video.src);
  video.src = URL.createObjectURL(f);
  loadFFmpeg().catch(() => {}); // start fetching the encoder in the background
}

video.addEventListener('loadedmetadata', () => {
  duration = video.duration;
  stage.style.setProperty('--ar', video.videoWidth / video.videoHeight);
  // Instant replay saves the moment at the end, so default to the last 30 seconds.
  selEnd = round1(duration);
  selStart = round1(Math.max(0, duration - 30));
  video.currentTime = selStart;
  drop.hidden = true;
  editor.hidden = false;
  render();
  renderCrop();
});

video.addEventListener('error', () => {
  if (!file) return;
  editor.hidden = true;
  drop.hidden = false;
  dropError.textContent = `Couldn't play "${file.name}" in this browser. Try an MP4 (H.264) recording.`;
  dropError.hidden = false;
});

/* ---------------- playback + timeline ---------------- */

function togglePlay() {
  if (video.paused) {
    if (video.currentTime < selStart || video.currentTime >= selEnd - 0.05) video.currentTime = selStart;
    video.play();
  } else {
    video.pause();
  }
}

playBtn.onclick = togglePlay;
video.addEventListener('click', togglePlay);
video.addEventListener('play', () => playBtn.classList.add('playing'));
video.addEventListener('pause', () => playBtn.classList.remove('playing'));

const pct = (t) => `${(duration ? t / duration : 0) * 100}%`;

(function tick() {
  if (!video.paused && video.currentTime >= selEnd) video.currentTime = selStart; // loop the selection
  if (duration) {
    playhead.style.left = pct(video.currentTime);
    clock.textContent = `${fmt(video.currentTime)} / ${fmt(duration)}`;
  }
  requestAnimationFrame(tick);
})();

function render() {
  range.style.left = hStart.style.left = pct(selStart);
  hEnd.style.left = pct(selEnd);
  range.style.width = pct(selEnd - selStart);
  startIn.value = fmt(selStart);
  endIn.value = fmt(selEnd);
  len.textContent = fmtLen(selEnd - selStart);
}

function setStart(t) {
  t = clamp(round1(t), 0, duration - MIN_CLIP);
  if (t > selEnd - MIN_CLIP) selEnd = Math.min(round1(duration), t + (selEnd - selStart)); // keep the length
  selStart = t;
}

function setEnd(t) {
  selEnd = clamp(round1(t), selStart + MIN_CLIP, duration);
}

track.parentElement.addEventListener('pointerdown', (e) => {
  const mode = e.target === hStart ? 'start' : e.target === hEnd ? 'end' : 'seek';
  const el = e.currentTarget;
  el.setPointerCapture(e.pointerId);
  const move = (ev) => {
    const r = track.getBoundingClientRect();
    const t = clamp((ev.clientX - r.left) / r.width, 0, 1) * duration;
    if (mode === 'start') { setStart(Math.min(t, selEnd - MIN_CLIP)); video.currentTime = selStart; }
    else if (mode === 'end') { setEnd(t); video.currentTime = selEnd; }
    else video.currentTime = t;
    render();
  };
  const up = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    if (mode === 'end') video.currentTime = selStart;
  };
  if (mode === 'seek') move(e);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
});

for (const [input, set] of [[startIn, setStart], [endIn, setEnd]]) {
  input.addEventListener('change', () => {
    const t = parseTime(input.value);
    if (t != null) {
      set(t);
      video.currentTime = input === startIn ? selStart : selEnd;
    }
    render();
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
}

document.addEventListener('keydown', (e) => {
  if (editor.hidden || e.target.tagName === 'INPUT' || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === ' ') { e.preventDefault(); togglePlay(); }
  else if (k === 'i') { setStart(video.currentTime); render(); }
  else if (k === 'o') { setEnd(video.currentTime); render(); }
});

/* ---------------- crop ---------------- */

const MIN_CROP = 0.05;

cropBtn.onclick = () => {
  cropOn = !cropOn;
  cropBtn.classList.toggle('active', cropOn);
  cropBtn.querySelector('span').textContent = cropOn ? 'Remove crop' : 'Crop';
  renderCrop();
};

function cropPixels() {
  const W = video.videoWidth, H = video.videoHeight;
  if (!cropOn) return { x: 0, y: 0, w: even(W), h: even(H) };
  const w = even(crop.w * W), h = even(crop.h * H);
  return {
    x: clamp(Math.round(crop.x * W), 0, W - w),
    y: clamp(Math.round(crop.y * H), 0, H - h),
    w, h,
  };
}

function renderCrop() {
  cropEl.hidden = !cropOn;
  Object.assign(cropEl.style, {
    left: `${crop.x * 100}%`, top: `${crop.y * 100}%`,
    width: `${crop.w * 100}%`, height: `${crop.h * 100}%`,
  });
  const px = cropPixels();
  cropSize.textContent = `${px.w}×${px.h}`;
}

cropEl.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const mode = e.target.dataset.h || 'move';
  const r = stage.getBoundingClientRect();
  const sx = e.clientX, sy = e.clientY, c0 = { ...crop };
  cropEl.setPointerCapture(e.pointerId);

  const move = (ev) => {
    const dx = (ev.clientX - sx) / r.width, dy = (ev.clientY - sy) / r.height;
    let { x, y, w, h } = c0;
    if (mode === 'move') {
      x = clamp(x + dx, 0, 1 - w);
      y = clamp(y + dy, 0, 1 - h);
    } else {
      if (mode.includes('w')) { const nx = clamp(x + dx, 0, x + w - MIN_CROP); w += x - nx; x = nx; }
      if (mode.includes('e')) w = clamp(w + dx, MIN_CROP, 1 - x);
      if (mode.includes('n')) { const ny = clamp(y + dy, 0, y + h - MIN_CROP); h += y - ny; y = ny; }
      if (mode.includes('s')) h = clamp(h + dy, MIN_CROP, 1 - y);
    }
    crop = { x, y, w, h };
    renderCrop();
  };
  const up = () => {
    cropEl.removeEventListener('pointermove', move);
    cropEl.removeEventListener('pointerup', up);
    cropEl.removeEventListener('pointercancel', up);
  };
  cropEl.addEventListener('pointermove', move);
  cropEl.addEventListener('pointerup', up);
  cropEl.addEventListener('pointercancel', up);
});

/* ---------------- ffmpeg ---------------- */

let ff = null;           // loaded FFmpeg instance
let ffLoading = null;    // promise for the instance
let coreURLs = null;     // promise for blob URLs of the core (downloaded once per page load)
let loadProgress = 0;
let mounted = null;      // File currently mounted at /in
let probed = null;       // { file, fps, hasAudio }
let logLines = [];
let onProgressLine = null;

async function toBlobURL(url, type, expectedBytes) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't download the video encoder (${res.status})`);
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (expectedBytes) loadProgress = Math.min(1, got / expectedBytes);
  }
  return URL.createObjectURL(new Blob(chunks, { type }));
}

function loadFFmpeg() {
  coreURLs ??= Promise.all([
    toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
    toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm', CORE_WASM_BYTES),
  ]).catch((err) => { coreURLs = null; throw err; });

  ffLoading ??= (async () => {
    const [coreURL, wasmURL] = await coreURLs;
    const inst = new FFmpeg();
    inst.on('log', ({ message }) => {
      logLines.push(message);
      if (logLines.length > 300) logLines.shift();
      onProgressLine?.(message);
    });
    await inst.load({ coreURL, wasmURL });
    ff = inst;
    mounted = null;
    return inst;
  })().catch((err) => { ffLoading = null; throw err; });

  return ffLoading;
}

function killFFmpeg() {
  ff?.terminate();
  ff = null;
  ffLoading = null;
  mounted = null;
}

const inPath = () => `/in/${file.name}`;

async function mountFile(inst) {
  if (mounted === file) return;
  if (mounted) await inst.unmount('/in');
  else await inst.createDir('/in').catch(() => {});
  // WORKERFS reads straight from the File, so multi-GB recordings never get copied into memory.
  await inst.mount('WORKERFS', { files: [file] }, '/in');
  mounted = file;
}

async function probe(inst) {
  if (probed?.file === file) return probed;
  logLines = [];
  await inst.exec(['-hide_banner', '-i', inPath()]); // "fails" (no output) but logs stream info
  const text = logLines.join('\n');
  const fps = parseFloat(text.match(/Video:.*?([\d.]+) fps/)?.[1]);
  probed = { file, fps: fps > 0 ? fps : 60, hasAudio: /Stream #.*Audio:/.test(text) };
  return probed;
}

// Bitrate that lands the whole file near TARGET_BYTES.
function videoBitrateFor(dur, hasAudio) {
  const totalBps = (TARGET_BYTES * 8 * 0.98) / dur; // ~2% MP4 container overhead
  return Math.max(150e3, totalBps - (hasAudio ? AUDIO_BPS : 0));
}

// Keep the crop's resolution unless the bitrate is too thin for it, then scale down just enough.
function outputSize(src, vbps, fps) {
  const bpp = vbps / (src.w * src.h * Math.min(fps, 60));
  let s = Math.min(1, Math.sqrt(bpp / MIN_BPP));
  s = Math.max(s, Math.min(1, MIN_HEIGHT / Math.min(src.w, src.h)));
  return { w: even(src.w * s), h: even(src.h * s) };
}

/* ---------------- export ---------------- */

function setStatus(text, frac) {
  statusEl.hidden = false;
  statusEl.classList.remove('failed');
  statusText.textContent = text;
  bar.classList.toggle('indeterminate', frac == null);
  barFill.style.width = frac == null ? '' : `${frac * 100}%`;
}

function setBusy(b) {
  busy = b;
  exportBtn.disabled = b;
  another.disabled = b;
  cancelBtn.hidden = !b;
}

exportBtn.onclick = exportClip;

cancelBtn.onclick = () => {
  job++;
  killFFmpeg();
  statusEl.hidden = true;
  setBusy(false);
};

async function exportClip() {
  if (busy || !file) return;
  const start = selStart, dur = round1(selEnd - selStart);
  const src = cropPixels();
  const id = ++job;
  const cancelled = () => id !== job;
  resultEl.hidden = true;
  setBusy(true);
  video.pause();

  try {
    let inst = ff;
    if (!inst) {
      const timer = setInterval(() => setStatus(`Loading video encoder… ${Math.round(loadProgress * 100)}%`, loadProgress), 200);
      try { inst = await loadFFmpeg(); } finally { clearInterval(timer); }
    }
    if (cancelled()) return;

    setStatus('Reading video…');
    await mountFile(inst);
    const { fps, hasAudio } = await probe(inst);

    let vbps = videoBitrateFor(dur, hasAudio);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const out = outputSize(src, vbps, fps);
      const data = await encode(inst, { start, dur, src, out, vbps, hasAudio, attempt });
      if (cancelled()) return;

      if (data.length <= MAX_BYTES) return showResult(data, dur, out);
      // Too big: scale the bitrate by how far over we were, with a little extra margin.
      vbps *= (TARGET_BYTES / data.length) * 0.95;
    }
    throw new Error("Couldn't get the clip under 20 MB. Try a shorter selection.");
  } catch (err) {
    if (cancelled()) return;
    console.error(err);
    setStatus(`Export failed: ${err.message || err}`);
    statusEl.classList.add('failed');
  } finally {
    if (!cancelled()) setBusy(false);
  }
}

async function encode(inst, { start, dur, src, out, vbps, hasAudio, attempt }) {
  const W = video.videoWidth, H = video.videoHeight;
  const filters = [];
  if (src.w !== W || src.h !== H) filters.push(`crop=${src.w}:${src.h}:${src.x}:${src.y}`);
  if (out.w !== src.w || out.h !== src.h) filters.push(`scale=${out.w}:${out.h}`);
  filters.push('setsar=1');

  const k = Math.round(vbps / 1000);
  const args = [
    '-ss', start.toFixed(3), '-i', inPath(), '-t', dur.toFixed(3),
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', filters.join(','),
    '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-b:v', `${k}k`, '-maxrate', `${Math.round(k * 1.5)}k`, '-bufsize', `${k * 2}k`,
    ...(hasAudio ? ['-c:a', 'aac', '-b:a', `${AUDIO_BPS / 1000}k`, '-ac', '2'] : []),
    '-movflags', '+faststart', '-y', '/out.mp4',
  ];

  const label = attempt === 1 ? 'Encoding' : `Too big, re-encoding at a lower bitrate (try ${attempt})`;
  const t0 = performance.now();
  setStatus(`${label}… 0%`, 0);
  onProgressLine = (msg) => {
    const m = msg.match(/time=(\d+):(\d+):([\d.]+)/);
    if (!m) return;
    const frac = clamp((+m[1] * 3600 + +m[2] * 60 + +m[3]) / dur, 0, 1);
    const elapsed = (performance.now() - t0) / 1000;
    const left = frac > 0.03 ? Math.round(elapsed / frac - elapsed) : null;
    const eta = left == null ? '' : left >= 60 ? ` · about ${Math.ceil(left / 60)} min left` : ` · ${left}s left`;
    setStatus(`${label}… ${Math.round(frac * 100)}%${eta}`, frac);
  };

  logLines = [];
  let code;
  try { code = await inst.exec(args); } finally { onProgressLine = null; }
  if (code !== 0) {
    const detail = logLines.filter((l) => /error|invalid|failed/i.test(l)).pop() || `ffmpeg exited with code ${code}`;
    throw new Error(detail);
  }
  const data = await inst.readFile('/out.mp4');
  await inst.deleteFile('/out.mp4');
  return data;
}

function showResult(data, dur, out) {
  if (resultURL) URL.revokeObjectURL(resultURL);
  resultURL = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }));
  download.href = resultURL;
  download.download = `${file.name.replace(/\.[^.]+$/, '')}-clip.mp4`;
  resultInfo.textContent = `${(data.length / 1e6).toFixed(1)} MB · ${fmtLen(dur)} · ${out.w}×${out.h}`;
  statusEl.hidden = true;
  resultEl.hidden = false;
}
