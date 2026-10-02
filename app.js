import { FFmpeg } from './vendor/ffmpeg/index.js';

// ffmpeg cores, pinned so the exact sizes are known. The multi-threaded core is ~2x faster but needs
// SharedArrayBuffer (cross-origin isolation via the headers in vercel.json) and occasionally deadlocks,
// so we fall back to the single-threaded core when it isn't available or stalls.
const CORES = {
  mt: { base: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@0.12.10/dist/esm', wasmBytes: 32718323 },
  st: { base: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm', wasmBytes: 32232419 },
};
// The mt core pre-spawns 32 pthreads; x264's automatic thread count can exceed that and hang, so cap it.
const THREADS = String(Math.max(2, Math.min(8, navigator.hardwareConcurrency || 4)));
const STALL_MS = 45000;      // no ffmpeg output for this long = assume the mt core deadlocked
let useMT = self.crossOriginIsolated === true;

const TARGET_BYTES = 18e6;   // aim for ~18 MB
const MAX_BYTES = 20e6;      // never exceed 20 MB
const AUDIO_BPS = 128e3;
const MIN_BPP = 0.06;        // below this many bits/pixel/frame, downscale instead of starving quality
const MIN_HEIGHT = 360;
const MIN_CLIP = 0.5;
const MAX_ATTEMPTS = 5;
const UNDERSHOOT = 0.94;   // if a clip lands under ~17 MB, re-encode once at a higher bitrate

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
let coreURLs = null;     // { mt, promise } for blob URLs of the core (downloaded once per page load)
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
  if (coreURLs?.mt !== useMT) {
    const { base, wasmBytes } = useMT ? CORES.mt : CORES.st;
    loadProgress = 0;
    const promise = Promise.all([
      toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
      toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm', wasmBytes),
      useMT ? toBlobURL(`${base}/ffmpeg-core.worker.js`, 'text/javascript') : undefined,
    ]);
    coreURLs = { mt: useMT, promise };
    promise.catch(() => { if (coreURLs?.promise === promise) coreURLs = null; });
  }
  const urls = coreURLs.promise;

  ffLoading ??= (async () => {
    const [coreURL, wasmURL, workerURL] = await urls;
    const inst = new FFmpeg();
    inst.on('log', ({ message }) => {
      logLines.push(message);
      if (logLines.length > 300) logLines.shift();
      onProgressLine?.(message);
    });
    await inst.load(workerURL ? { coreURL, wasmURL, workerURL } : { coreURL, wasmURL });
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

class StallError extends Error {}

// Runs ffmpeg, but gives up if it goes silent for STALL_MS (the mt core can deadlock instead of failing).
function execWatched(inst, args) {
  if (!useMT) return inst.exec(args);
  return new Promise((resolve, reject) => {
    let seen = logLines.length, quietSince = performance.now();
    const timer = setInterval(() => {
      if (logLines.length !== seen) { seen = logLines.length; quietSince = performance.now(); }
      else if (performance.now() - quietSince > STALL_MS) { clearInterval(timer); reject(new StallError('stalled')); }
    }, 1000);
    inst.exec(args).then(resolve, reject).finally(() => clearInterval(timer));
  });
}

async function probe(inst) {
  if (probed?.file === file) return probed;
  logLines = [];
  await execWatched(inst, ['-hide_banner', '-i', inPath()]); // "fails" (no output) but logs stream info
  const text = logLines.join('\n');
  const fps = parseFloat(text.match(/Video:.*?([\d.]+) fps/)?.[1]);
  probed = { file, fps: fps > 0 ? fps : 60, hasAudio: /Stream #.*Audio:/.test(text) };
  return probed;
}

// Bitrate that lands the whole file near TARGET_BYTES.
function videoBitrateFor(dur, hasAudio) {
  const totalBps = (TARGET_BYTES * 8 * 0.995) / dur; // MP4 overhead measured at well under 1%
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
    let best = null;      // largest encode that fit under MAX_BYTES
    let toppedUp = false;
    let lastUnder = true;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const out = outputSize(src, vbps, fps);
      const label = attempt === 1 ? 'Encoding'
        : lastUnder ? 'Using the leftover space for better quality, re-encoding'
        : `Too big, re-encoding at a lower bitrate (try ${attempt})`;
      const data = await encode(inst, { start, dur, src, out, vbps, hasAudio, label });
      if (cancelled()) return;

      if (data.length <= MAX_BYTES && (!best || data.length > best.data.length)) best = { data, out };
      if (best && (toppedUp || best.data.length >= TARGET_BYTES * UNDERSHOOT)) break;

      // Scale the bitrate by how far off we landed: up to fill unused space (once), down if over 20 MB.
      const under = data.length <= MAX_BYTES;
      if (under) toppedUp = true;
      lastUnder = under;
      vbps *= (TARGET_BYTES / data.length) * (under ? 0.99 : 0.95);
    }
    if (best) return showResult(best.data, dur, best.out);
    throw new Error("Couldn't get the clip under 20 MB. Try a shorter selection.");
  } catch (err) {
    if (cancelled()) return;
    if (useMT && (err instanceof StallError || /SharedArrayBuffer|load/i.test(err.message))) {
      // Multi-threaded core hung or wouldn't start: switch to the single-threaded core and start over.
      console.warn('Multi-threaded ffmpeg failed, falling back to single-threaded:', err);
      useMT = false;
      killFFmpeg();
      setBusy(false);
      return exportClip();
    }
    console.error(err);
    setStatus(`Export failed: ${err.message || err}`);
    statusEl.classList.add('failed');
  } finally {
    if (!cancelled()) setBusy(false);
  }
}

async function encode(inst, { start, dur, src, out, vbps, hasAudio, label }) {
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
    ...(useMT ? ['-threads', THREADS] : []),
    '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-b:v', `${k}k`, '-maxrate', `${Math.round(k * 1.5)}k`, '-bufsize', `${k * 2}k`,
    ...(hasAudio ? ['-c:a', 'aac', '-b:a', `${AUDIO_BPS / 1000}k`, '-ac', '2'] : []),
    '-movflags', '+faststart', '-y', '/out.mp4',
  ];

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
  try { code = await execWatched(inst, args); } finally { onProgressLine = null; }
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
