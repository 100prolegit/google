/* popup.js
   ✅ Purple Player – Extension Popup Script
   - 1:1 aus deinem <script>-Block übernommen
   - Hinweis: rubberband-processor.js muss lokal unter /js/ liegen und in popup.html vor popup.js geladen werden
*/

/* =========================================================
   ✅ GLOBAL AUTO-FIT (iPhone Safari / alle kleinen Screens)
   - Skaliert so weit runter, dass das Plugin komplett in den sichtbaren Viewport passt
   - Nutzt visualViewport (Safari Adressleiste/Bottombar korrekt)
========================================================= */
(function(){
  const root = document.documentElement;
  const plugin = document.getElementById("pluginRoot");
  if(!plugin) return;

  function vpSize(){
    const vv = window.visualViewport;
    const w = vv ? vv.width  : window.innerWidth;
    const h = vv ? vv.height : window.innerHeight;
    return { w, h };
  }

  function applyFit(){
    // erst auf 1 setzen, dann messen
    root.style.setProperty("--fitScale", "1");

    requestAnimationFrame(() => {
      const { w: vw, h: vh } = vpSize();

      // Safari UI + safe-area: kleiner Puffer
      const safe = 10;

      // unskaliertes Maß
      const rect = plugin.getBoundingClientRect();
      const pw = rect.width;
      const ph = rect.height;

      if(!pw || !ph) return;

      // scale so, dass es komplett reinpasst (Breite UND Höhe)
      let scale = Math.min((vw - safe) / pw, (vh - safe) / ph, 1);

      // wenn es nur minimal überläuft, trotzdem leicht verkleinern
      scale = Math.max(0.2, Math.min(1, scale));

      root.style.setProperty("--fitScale", String(scale));
    });
  }

  // visuelle Änderungen (Safari Adressleiste) -> visualViewport resize
  if(window.visualViewport){
    window.visualViewport.addEventListener("resize", applyFit, { passive:true });
    window.visualViewport.addEventListener("scroll", applyFit, { passive:true });
  }

  window.addEventListener("resize", applyFit, { passive:true });
  window.addEventListener("orientationchange", applyFit, { passive:true });
  document.addEventListener("visibilitychange", applyFit, { passive:true });

  applyFit();
})();

/* =========================================================
   0) Video + LEAN Scrub
========================================================= */
const video = document.getElementById("video");
let videoDuration = 0;

video.addEventListener("loadedmetadata", () => {
  videoDuration = video.duration || 0;
});

function scrubVideoTo(p01){
  if(!videoDuration) return;
  const p = Math.max(0, Math.min(1, p01));
  const maxFillPoint = 0.648;
  const t = p * videoDuration * maxFillPoint;

  const now = performance.now() / 1000;
  const FPS = 30;
  const MIN_DT = 1 / FPS;
  if(now - (window.__lastVideoSet || 0) < MIN_DT) return;

  if(Math.abs((window.__lastVideoTime||0) - t) > 0.004){
    video.currentTime = t;
    window.__lastVideoTime = t;
  }
  window.__lastVideoSet = now;
}

/* =========================================================
   1) WEBAUDIO ENGINE
========================================================= */
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

const AC = window.AudioContext || window.webkitAudioContext;
const audioContext = new AC();

let audioBuffer = null;
let sourceNode = null;
let rubberband = null;

let startTime = 0;
let pauseOffset = 0;
let isPlaying = false;

/* Master */
const masterGain = audioContext.createGain();
masterGain.gain.value = 0.85;
masterGain.connect(audioContext.destination);

/* Dry */
const dryGain = audioContext.createGain();
dryGain.gain.value = 1.0;
dryGain.connect(masterGain);

/* Flanger */
const flangerDelay = audioContext.createDelay();
flangerDelay.delayTime.value = 0.003;

const flangerFeedback = audioContext.createGain();
flangerFeedback.gain.value = 0.7;

const flangerWet = audioContext.createGain();
flangerWet.gain.value = 0.0;
flangerWet.connect(masterGain);

flangerDelay.connect(flangerFeedback);
flangerFeedback.connect(flangerDelay);

/* LFO */
const lfo = audioContext.createOscillator();
const lfoGain = audioContext.createGain();
lfo.frequency.value = 0.3;
lfoGain.gain.value = 0.001;
lfo.connect(lfoGain);
lfoGain.connect(flangerDelay.delayTime);
lfo.start();

/* Reverb */
const convolver = audioContext.createConvolver();
const reverbWet = audioContext.createGain();
reverbWet.gain.value = 0.0;
reverbWet.connect(masterGain);

function createImpulseResponse(duration=2, decay=2.5){
  const rate = audioContext.sampleRate;
  const length = Math.floor(rate * duration);
  const impulse = audioContext.createBuffer(2, length, rate);
  for(let c=0;c<2;c++){
    const channel = impulse.getChannelData(c);
    for(let i=0;i<length;i++){
      channel[i] = (Math.random()*2-1) * Math.pow(1 - i/length, decay);
    }
  }
  return impulse;
}
convolver.buffer = createImpulseResponse();

function stopSource(){
  if(!sourceNode) return;
  try{ sourceNode.onended = null; }catch{}
  try{ sourceNode.stop(); }catch{}
  try{ sourceNode.disconnect(); }catch{}
  sourceNode = null;
  rubberband = null;
}

function routeSource(node){
  node.connect(dryGain);
  node.connect(flangerDelay);
  flangerDelay.connect(flangerWet);
  node.connect(convolver);
  convolver.connect(reverbWet);
}

/* Pitch */
function pToPitch(p01){
  const p = clamp01(p01);
  return 0.55 + 0.45 * p;
}
let currentPitch = 1.0;

function setPitchLive(pitch){
  const v = clamp(pitch, 0.55, 1.0);
  currentPitch = v;

  if(rubberband && typeof rubberband.setPitch === "function"){
    rubberband.setPitch(v);
    return;
  }
  if(sourceNode && sourceNode.playbackRate){
    sourceNode.playbackRate.value = v;
  }
}

async function ensureAudio(){
  if(audioContext.state === "suspended"){
    try{ await audioContext.resume(); }catch{}
  }
}

function getCurrentTime(){
  if(!audioBuffer) return 0;
  if(isPlaying){
    return clamp(audioContext.currentTime - startTime + pauseOffset, 0, audioBuffer.duration);
  }
  return clamp(pauseOffset, 0, audioBuffer.duration);
}

function startPlayback(){
  if(!audioBuffer) return;

  stopSource();

  if(typeof RubberbandProcessor !== "undefined"){
    rubberband = new RubberbandProcessor(audioContext, audioBuffer);
    if(typeof rubberband.setPitch === "function") rubberband.setPitch(currentPitch);
    sourceNode = (typeof rubberband.getSource === "function") ? rubberband.getSource() : null;
  }

  if(!sourceNode){
    rubberband = null;
    sourceNode = audioContext.createBufferSource();
    sourceNode.buffer = audioBuffer;
    sourceNode.playbackRate.value = currentPitch;
  }

  routeSource(sourceNode);

  startTime = audioContext.currentTime;
  sourceNode.start(0, pauseOffset);
  isPlaying = true;

  sourceNode.onended = () => {
    if(isPlaying){
      isPlaying = false;
      pauseOffset = 0;
      btnPlay.textContent = "▶";
      if(tracks.length){
        const next = (current + 1) % tracks.length;
        loadTrack(next, true);
      }
    }
  };
}

function pausePlayback(){
  if(!isPlaying) return;
  pauseOffset = getCurrentTime();
  stopSource();
  isPlaying = false;
}

function seekTo(seconds){
  if(!audioBuffer) return;
  pauseOffset = clamp(seconds, 0, audioBuffer.duration);
  if(isPlaying) startPlayback();
}

/* FX mix */
function setFlangerMix(v01){ flangerWet.gain.value = clamp01(v01); }
function setReverbMix(v01){ reverbWet.gain.value = clamp01(v01); }
function setMasterVol(v01){ masterGain.gain.value = clamp01(v01); }

/* =========================================================
   2) Smooth Vertical Slider
========================================================= */
function createSmoothVSlider({ sliderEl, tooltipEl, wrapEl, maxValue, uiSmooth = 0.22, onValue }){
  let targetP = Number(sliderEl.value) / maxValue;
  let uiP = targetP;

  let wrapRect = null;
  let sliderRect = null;

  function measure(){
    wrapRect = wrapEl.getBoundingClientRect();
    sliderRect = sliderEl.getBoundingClientRect();
  }
  window.addEventListener("resize", measure, { passive:true });

  function updateGradient(p){
    const p100 = p * 100;
    sliderEl.style.background = `linear-gradient(to right,var(--purple) 0%,var(--purple) ${p100}%,#ddd ${p100}%,#ddd 100%)`;
  }

  function updateTooltip(p){
    tooltipEl.textContent = (p * 100).toFixed(1) + "%";
    if (!wrapRect || !sliderRect) return;

    const y = (1 - p) * sliderRect.height;
    const left = (sliderRect.left - wrapRect.left) + (sliderRect.width / 2);
    const top  = (sliderRect.top  - wrapRect.top) + y;

    tooltipEl.style.left = left + "px";
    tooltipEl.style.top  = top + "px";
  }

  function showTip(){ measure(); tooltipEl.style.opacity = 1; }
  function hideTip(){ tooltipEl.style.opacity = 0; }

  sliderEl.addEventListener("mouseenter", showTip);
  sliderEl.addEventListener("mouseleave", hideTip);
  sliderEl.addEventListener("pointerdown", showTip);
  sliderEl.addEventListener("pointerup", hideTip);
  sliderEl.addEventListener("pointercancel", hideTip);

  sliderEl.addEventListener("input", () => {
    targetP = clamp01(Number(sliderEl.value) / maxValue);
  }, { passive:true });

  function tick(nowMs){
    uiP += (targetP - uiP) * uiSmooth;
    updateGradient(uiP);
    updateTooltip(uiP);
    if (onValue) onValue(uiP, nowMs/1000);
    requestAnimationFrame(tick);
  }

  measure();
  requestAnimationFrame(tick);
}

/* ✅ LEAN: Pitch + MP4 scrub */
createSmoothVSlider({
  sliderEl: document.getElementById("sliderLean"),
  tooltipEl: document.getElementById("tipLean"),
  wrapEl: document.getElementById("wrapLean"),
  maxValue: 648,
  uiSmooth: 0.22,
  onValue: (p) => {
    setPitchLive(pToPitch(p));
    scrubVideoTo(p);
  }
});

/* FLANGER */
createSmoothVSlider({
  sliderEl: document.getElementById("sliderFlanger"),
  tooltipEl: document.getElementById("tipFlanger"),
  wrapEl: document.getElementById("wrapFlanger"),
  maxValue: 1000,
  uiSmooth: 0.22,
  onValue: (p) => setFlangerMix(p)
});

/* REVERB knob */
(function initReverbKnob(){
  const input = document.getElementById("reverb");
  const ui = document.getElementById("reverb_ui");
  const tip = document.getElementById("tipReverb");

  let target = Number(input.value);
  let val = target;
  const SMOOTH = 0.25;

  function setAngle(v01){
    const a = -135 + (270 * clamp01(v01));
    ui.style.setProperty("--a", `${a}deg`);
    ui.setAttribute("aria-valuenow", String(v01));
    tip.textContent = (v01 * 100).toFixed(1) + "%";
  }
  function showTip(){ tip.style.opacity = 1; }
  function hideTip(){ tip.style.opacity = 0; }

  setAngle(val);
  setReverbMix(val);

  let dragging = false;
  let startY = 0;
  let startVal = 0;

  ui.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    dragging = true;
    startY = e.clientY;
    startVal = target;
    ui.setPointerCapture(e.pointerId);
    showTip();
    e.preventDefault();
  });

  ui.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dy = startY - e.clientY;
    target = clamp01(startVal + dy / 180);
    input.value = String(target);
  });

  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    try { ui.releasePointerCapture(e.pointerId); } catch {}
    hideTip();
  };

  ui.addEventListener("pointerup", end);
  ui.addEventListener("pointercancel", end);

  ui.addEventListener("mouseenter", showTip);
  ui.addEventListener("mouseleave", () => { if (!dragging) hideTip(); });

  ui.addEventListener("keydown", (e) => {
    const step = 0.02;
    if (!["ArrowLeft","ArrowDown","ArrowRight","ArrowUp"].includes(e.key)) return;
    let v = target;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") v = clamp01(v - step);
    if (e.key === "ArrowRight" || e.key === "ArrowUp") v = clamp01(v + step);
    target = v;
    input.value = String(target);
    showTip();
    clearTimeout(ui._tipT);
    ui._tipT = setTimeout(() => { if (!dragging) hideTip(); }, 600);
  });

  function tick(){
    val += (target - val) * SMOOTH;
    setAngle(val);
    setReverbMix(val);
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();

/* =========================================================
   3) Player / Playlist
========================================================= */
const filePick = document.getElementById("filePick");
const btnAdd = document.getElementById("btnAdd");
const btnPlay = document.getElementById("btnPlay");
const btnPrev = document.getElementById("btnPrev");
const btnNext = document.getElementById("btnNext");
const btnClear = document.getElementById("btnClear");
const vol = document.getElementById("vol");
const playlistEl = document.getElementById("playlist");
const nowPlayingEl = document.getElementById("nowPlaying");

let tracks = [];
let current = -1;

function setVolUI(v){
  const p = clamp01(v);
  vol.value = String(p);
  vol.style.background = `linear-gradient(to right,var(--purple) ${p*100}%, #ddd ${p*100}%)`;
  setMasterVol(p);
}
setVolUI(0.85);
vol.addEventListener("input", () => setVolUI(Number(vol.value)), { passive:true });

btnAdd.addEventListener("click", () => filePick.click());

filePick.addEventListener("change", (e) => {
  const files = Array.from(e.target.files || []);
  if(!files.length) return;
  for(const f of files){
    const url = URL.createObjectURL(f);
    tracks.push({ name: f.name, url, file: f, dur: null });
  }
  renderPlaylist();
  if(current === -1) loadTrack(0, false);
  filePick.value = "";
});

btnPlay.addEventListener("click", async () => {
  await ensureAudio();
  try{ video.pause(); }catch{}

  if(current === -1 && tracks.length) await loadTrack(0, false);
  if(!audioBuffer) return;

  if(!isPlaying){
    startPlayback();
    btnPlay.textContent = "❚❚";
  }else{
    pausePlayback();
    btnPlay.textContent = "▶";
  }
});

btnPrev.addEventListener("click", async () => {
  if(!tracks.length) return;
  await ensureAudio();
  const i = current <= 0 ? tracks.length - 1 : current - 1;
  await loadTrack(i, true);
});
btnNext.addEventListener("click", async () => {
  if(!tracks.length) return;
  await ensureAudio();
  const i = (current + 1) % tracks.length;
  await loadTrack(i, true);
});

btnClear.addEventListener("click", () => {
  stopSource();
  isPlaying = false;
  audioBuffer = null;
  pauseOffset = 0;
  btnPlay.textContent = "▶";

  for(const t of tracks){ try{ URL.revokeObjectURL(t.url); }catch{} }
  tracks = [];
  current = -1;

  nowPlayingEl.innerHTML = `<div>Keine Tracks geladen</div><span>Füge MP3/WAV/etc. hinzu</span>`;
  renderPlaylist();
  buildWaveformFromFile(null);
});

function fmtTime(sec){
  if(!isFinite(sec) || sec < 0) return "--:--";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2,"0")}`;
}

function updateNowPlaying(){
  if(current < 0 || !tracks[current]){
    nowPlayingEl.innerHTML = `<div>Keine Tracks geladen</div><span>Füge MP3/WAV/etc. hinzu</span>`;
    return;
  }
  const dur = audioBuffer ? audioBuffer.duration : (tracks[current].dur || 0);
  nowPlayingEl.innerHTML = `<div>${tracks[current].name}</div><span>${fmtTime(getCurrentTime())} / ${fmtTime(dur)}</span>`;
}

function renderPlaylist(){
  playlistEl.innerHTML = "";
  if(!tracks.length){
    const empty = document.createElement("div");
    empty.style.padding = "10px";
    empty.style.fontWeight = "900";
    empty.style.color = "#4b4b59";
    empty.style.opacity = "0.9";
    empty.textContent = "Playlist leer";
    playlistEl.appendChild(empty);
    return;
  }

  tracks.forEach((t, i) => {
    const row = document.createElement("div");
    row.className = "track" + (i === current ? " active" : "");
    row.title = "Click to play";

    const left = document.createElement("div");
    left.style.minWidth = "0";

    const name = document.createElement("div");
    name.className = "trackName";
    name.textContent = t.name;

    const meta = document.createElement("div");
    meta.className = "trackMeta";
    meta.textContent = t.dur ? fmtTime(t.dur) : "--:--";

    left.appendChild(name);
    left.appendChild(meta);

    const right = document.createElement("div");
    right.style.display = "flex";
    right.style.alignItems = "center";
    right.style.gap = "6px";

    const del = document.createElement("button");
    del.className = "trackX";
    del.textContent = "✕";
    del.title = "Remove";
    del.addEventListener("click", (ev) => {
      ev.stopPropagation();
      removeTrack(i);
    });

    right.appendChild(del);

    row.appendChild(left);
    row.appendChild(right);

    row.addEventListener("click", async () => {
      await ensureAudio();
      await loadTrack(i, true);
    });

    playlistEl.appendChild(row);
  });
}

async function loadTrack(index, autoplay=false){
  if(index < 0 || index >= tracks.length) return;

  stopSource();
  isPlaying = false;
  pauseOffset = 0;

  current = index;
  renderPlaylist();

  const file = tracks[current].file;

  try{
    await ensureAudio();
    const arr = await file.arrayBuffer();
    const buf = await audioContext.decodeAudioData(arr.slice(0));
    audioBuffer = buf;
    tracks[current].dur = buf.duration;

    await buildWaveformFromFile(file);
    waveMeta.textContent = `Track • ${buf.numberOfChannels}ch • ${buf.sampleRate} Hz • ${buf.duration.toFixed(2)}s`;
    updateNowPlaying();

    if(autoplay){
      startPlayback();
      btnPlay.textContent = "❚❚";
    }else{
      btnPlay.textContent = "▶";
    }
  }catch(err){
    audioBuffer = null;
    waveMeta.textContent = "Track konnte nicht geladen werden (Codec/Browser).";
    btnPlay.textContent = "▶";
  }
}

function removeTrack(index){
  if(index < 0 || index >= tracks.length) return;

  const wasCurrent = (index === current);
  const removed = tracks.splice(index, 1)[0];
  try{ URL.revokeObjectURL(removed.url); }catch{}

  if(!tracks.length){
    stopSource();
    isPlaying = false;
    audioBuffer = null;
    pauseOffset = 0;
    current = -1;
    btnPlay.textContent = "▶";
    buildWaveformFromFile(null);
    updateNowPlaying();
  }else{
    if(wasCurrent){
      const next = Math.min(index, tracks.length - 1);
      loadTrack(next, true);
    }else if(index < current){
      current -= 1;
      renderPlaylist();
      updateNowPlaying();
    }else{
      renderPlaylist();
      updateNowPlaying();
    }
  }
}

/* =========================================================
   4) Waveform
========================================================= */
const waveCanvas = document.getElementById("waveCanvas");
const waveMeta = document.getElementById("waveMeta");
const wctx = waveCanvas.getContext("2d");

let __waveAmps = null;
let __waveBars = 2000;
let __waveWin = 420;
let __waveSmooth = 0.65;

function fitCanvasToCSS(canvas){
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(rect.height * dpr);
  return { dpr };
}

function drawWaveWindow(amps, centerProgress01){
  if(!amps) return;
  const { dpr } = fitCanvasToCSS(waveCanvas);
  const W = waveCanvas.width, H = waveCanvas.height;

  wctx.setTransform(1,0,0,1,0,0);
  wctx.clearRect(0,0,W,H);

  wctx.fillStyle = "rgba(123,44,255,0.04)";
  wctx.fillRect(0,0,W,H);

  const mid = H/2;
  const pad = 12 * dpr;
  const usableH = H - pad*2;

  const n = amps.length;
  const win = Math.max(80, Math.min(__waveWin, n));
  const centerIdx = Math.floor(clamp01(centerProgress01) * (n - 1));
  const start = Math.max(0, Math.min(n - win, centerIdx - Math.floor(win/2)));

  const sm = __waveSmooth;

  wctx.strokeStyle = "rgba(123,44,255,0.95)";
  wctx.lineWidth = Math.max(1, 1.2 * dpr);
  wctx.lineCap = "round";

  const stepX = (W - pad*2) / win;

  wctx.beginPath();
  let prev = amps[start] || 0;
  for(let i=0;i<win;i++){
    const idx = start + i;
    const x = pad + i * stepX;
    const a0 = amps[idx] || 0;
    const a = prev * sm + a0 * (1 - sm);
    prev = a;

    const y1 = mid - (a * usableH/2);
    const y2 = mid + (a * usableH/2);
    wctx.moveTo(x, y1);
    wctx.lineTo(x, y2);
  }
  wctx.stroke();

  wctx.strokeStyle = "rgba(0,0,0,0.10)";
  wctx.lineWidth = Math.max(1, 1 * dpr);
  wctx.beginPath();
  wctx.moveTo(pad, mid);
  wctx.lineTo(W - pad, mid);
  wctx.stroke();

  const x = pad + (W - pad*2) * 0.5;
  wctx.strokeStyle = "rgba(29,29,34,0.65)";
  wctx.lineWidth = Math.max(1, 1.4 * dpr);
  wctx.beginPath();
  wctx.moveTo(x, 10*dpr);
  wctx.lineTo(x, H - 10*dpr);
  wctx.stroke();
}

async function buildWaveformFromFile(file){
  try{
    if(!file){
      __waveAmps = null;
      waveMeta.textContent = "Füge einen Track hinzu…";
      return;
    }

    waveMeta.textContent = "Waveform wird analysiert…";
    const arr = await file.arrayBuffer();
    const buf = await audioContext.decodeAudioData(arr.slice(0));

    const ch0 = buf.getChannelData(0);
    const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;

    const bars = __waveBars;
    const block = Math.floor(ch0.length / bars) || 1;
    const amps = new Float32Array(bars);

    for(let i=0;i<bars;i++){
      const start = i * block;
      let peak = 0;
      for(let j=0;j<block;j++){
        const idx = start + j;
        if(idx >= ch0.length) break;
        const v0 = Math.abs(ch0[idx]);
        const v = ch1 ? (v0 + Math.abs(ch1[idx])) * 0.5 : v0;
        if(v > peak) peak = v;
      }
      amps[i] = peak;
    }

    for(let i=0;i<amps.length;i++) amps[i] = Math.pow(amps[i], 0.6);
    let m = 0; for(const a of amps) if(a > m) m = a;
    if(m > 0) for(let i=0;i<amps.length;i++) amps[i] /= m;

    __waveAmps = amps;
  }catch(err){
    __waveAmps = null;
    waveMeta.textContent = "Waveform konnte nicht geladen werden (Codec/Browser).";
  }
}

function rafWave(){
  if(__waveAmps && audioBuffer && audioBuffer.duration){
    const p = getCurrentTime() / audioBuffer.duration;
    drawWaveWindow(__waveAmps, p);
  }else if(__waveAmps){
    drawWaveWindow(__waveAmps, 0);
  }
  updateNowPlaying();
  requestAnimationFrame(rafWave);
}
requestAnimationFrame(rafWave);

waveCanvas.addEventListener("pointerdown", async (e) => {
  if(!audioBuffer || !__waveAmps) return;
  await ensureAudio();
  const rect = waveCanvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  const delta = (x - 0.5) * audioBuffer.duration;
  seekTo(clamp(getCurrentTime() + delta, 0, audioBuffer.duration));
});

window.addEventListener("resize", () => {
  if(__waveAmps && audioBuffer){
    drawWaveWindow(__waveAmps, audioBuffer.duration ? (getCurrentTime() / audioBuffer.duration) : 0);
  }
}, { passive:true });

window.addEventListener("keydown", (e) => {
  if(e.target && ["INPUT","TEXTAREA"].includes(e.target.tagName)) return;
  if(e.code === "Space"){
    e.preventDefault();
    btnPlay.click();
  }
  if(e.code === "ArrowLeft" && (e.ctrlKey || e.metaKey)) btnPrev.click();
  if(e.code === "ArrowRight" && (e.ctrlKey || e.metaKey)) btnNext.click();
});
