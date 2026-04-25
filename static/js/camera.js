/* camera.js
 * Webcam lifecycle (getUserMedia + stream teardown), frame capture, and
 * the video-mode live-feed helpers. Exposes a pipeline-stop registry so
 * video.js can register each per-feature loop's teardown without causing
 * a circular import. */

import { RES, RES_OPTIONS, RES_DEFAULTS, setFrameSize } from "./state.js";

export const camVideo = document.getElementById("cam-video");
export const camLive = document.getElementById("cam-live");
export const camInterval = document.getElementById("cam-interval");
export const camIntervalVal = document.getElementById("cam-interval-val");
export const camFeedBody = document.getElementById("cam-feed-body");
export const camCanvas = document.getElementById("cam-canvas");
export const camLabels = document.getElementById("cam-labels");

// Mutable — assigned inside startCam, read across video.js pipelines.
export let camStream = null;
let camResizeObserver = null;

// video.js pipelines register their stop() via registerPipelineStop so
// stopCam can tear everything down without importing back.
const _pipelineStops = new Set();
export function registerPipelineStop(fn) { _pipelineStops.add(fn); }

// Overlay resync callback, set by overlays.js to avoid circular import.
let _syncOverlayRect = () => {};
export function setSyncOverlayRect(fn) { _syncOverlayRect = fn; }

// Restore saved polling interval.
const savedInterval = localStorage.getItem("chatlm.interval");
if (savedInterval) {
  camInterval.value = savedInterval;
  camIntervalVal.textContent = `${savedInterval}s`;
}

export async function startCam() {
  if (camStream) return;
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    camVideo.srcObject = camStream;
    const syncAspect = () => {
      const w = camVideo.videoWidth;
      const h = camVideo.videoHeight;
      if (w && h) camVideo.parentElement.style.aspectRatio = `${w} / ${h}`;
      _syncOverlayRect();
    };
    if (camVideo.videoWidth) syncAspect();
    camVideo.addEventListener("loadedmetadata", syncAspect, { once: true });
    camVideo.addEventListener("resize", syncAspect);
    if (!camResizeObserver) {
      camResizeObserver = new ResizeObserver(_syncOverlayRect);
      camResizeObserver.observe(camVideo);
      window.addEventListener("resize", _syncOverlayRect);
    }
  } catch (err) {
    appendFeed(`[CAM] failed: ${err.message}`, "err");
  }
}

export function stopCam() {
  for (const fn of _pipelineStops) {
    try { fn(); } catch (err) { console.warn("[cam] pipeline stop threw", err); }
  }
  if (camResizeObserver) {
    camResizeObserver.disconnect();
    camResizeObserver = null;
    window.removeEventListener("resize", _syncOverlayRect);
  }
  if (camStream) {
    camStream.getTracks().forEach((t) => t.stop());
    camStream = null;
  }
  camVideo.srcObject = null;
}

// ---------- frame capture ----------
// Re-uses a single OffscreenCanvas; cleared when a resolution changes.
const _captureCanvas = { canvas: null, cw: 0, ch: 0 };
export function invalidateCaptureCanvas() {
  _captureCanvas.canvas = null;
  _captureCanvas.cw = 0;
  _captureCanvas.ch = 0;
}

export async function captureFrame(max, quality = 0.7) {
  if (!camStream) return null;
  const w = camVideo.videoWidth || 640;
  const h = camVideo.videoHeight || 480;
  const scale = Math.min(1, max / Math.max(w, h));
  const cw = Math.round(w * scale);
  const ch = Math.round(h * scale);
  if (_captureCanvas.cw !== cw || _captureCanvas.ch !== ch) {
    _captureCanvas.canvas = new OffscreenCanvas(cw, ch);
    _captureCanvas.cw = cw;
    _captureCanvas.ch = ch;
  }
  const ctx = _captureCanvas.canvas.getContext("2d");
  ctx.drawImage(camVideo, 0, 0, cw, ch);
  const blob = await _captureCanvas.canvas.convertToBlob({ type: "image/jpeg", quality });
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// ---------- live-feed panel ----------
export function appendFeed(text, kind = "info") {
  const line = document.createElement("div");
  line.className = `feed-line feed-${kind}`;
  const ts = document.createElement("span");
  ts.className = "ts";
  ts.textContent = new Date().toLocaleTimeString();
  line.appendChild(ts);
  line.appendChild(document.createTextNode(text));
  camFeedBody.insertBefore(line, camFeedBody.firstChild);
  camFeedBody.scrollTop = 0;
  while (camFeedBody.children.length > 200) camFeedBody.lastChild.remove();
}

export function clearFeed() {
  camFeedBody.innerHTML = "";
}

// ---------- resolution dropdowns ----------
function fillResSelect(sel, current) {
  sel.innerHTML = "";
  for (const v of RES_OPTIONS) {
    const o = document.createElement("option");
    o.value = String(v);
    o.textContent = v === 160 ? "160 px (potato)" : v === 768 ? "768 px (sharp)" : `${v} px`;
    if (v === current) o.selected = true;
    sel.appendChild(o);
  }
}

for (const kind of Object.keys(RES_DEFAULTS)) {
  const sel = document.querySelector(`[data-res="${kind}"]`);
  if (!sel) continue;
  fillResSelect(sel, RES[kind]);
  sel.addEventListener("change", (e) => {
    const v = parseInt(e.target.value, 10);
    RES[kind] = v;
    localStorage.setItem(`chatlm.res.${kind}`, String(v));
    if (kind === "vision") setFrameSize(v);
    invalidateCaptureCanvas();
  });
}

camInterval.addEventListener("input", () => {
  camIntervalVal.textContent = `${camInterval.value}s`;
  localStorage.setItem("chatlm.interval", camInterval.value);
  // The live loop listens to camInterval directly on its next tick, so
  // we don't need to explicitly restart here.
});
