/* video.js
 * Video-mode pipelines: live scene description, object tracking (YOLO
 * + SAM), scanning, pose/face/people/bgsub/anime/segall, avatar, one-
 * shot (depth/OCR/cutout), inpaint/replace, img2img/generate.
 *
 * Kept as one module because the pipelines share overlay state + the
 * same camera lifecycle. Each pipeline registers a stop() with the
 * camera so `stopCam()` can tear everything down uniformly. */

import {
  camVideo, camStream, camLive, camInterval, camFeedBody,
  camCanvas, camLabels, captureFrame, appendFeed, clearFeed,
  registerPipelineStop, setSyncOverlayRect,
} from "./camera.js";
import { setStat } from "./core.js";
import { RES, FRAME_SIZE } from "./state.js";
import { addMessage } from "./messages.js";

// Pipeline-level token/timer state. Each loop's `startX` snapshots its
// token, its tick compares against the live token, and `stopX` bumps
// the counter so stale ticks bail out. Kept module-local.
let liveTimer = null;
let liveBusy = false;
let liveToken = 0;
let trackToken = 0;
let scanTimer = null;
let scanBusy = false;
let scanToken = 0;

const DEFAULT_LIVE_PROMPT = "Describe the scene in under 15 words.";
const DEFAULT_SCAN_PROMPT =
  "List up to {max_objects} distinct physical objects visible in this image. " +
  "Use lowercase singular nouns, one or two words each, no duplicates.";

function bindPromptField(textareaId, resetId, storageKey, defaultValue) {
  const el = document.getElementById(textareaId);
  el.value = localStorage.getItem(storageKey) || defaultValue;
  el.addEventListener("input", () => localStorage.setItem(storageKey, el.value));
  document.getElementById(resetId).addEventListener("click", () => {
    el.value = defaultValue;
    localStorage.setItem(storageKey, defaultValue);
  });
  return el;
}

const livePromptEl = bindPromptField(
  "live-prompt", "live-prompt-reset", "chatlm.livePrompt", DEFAULT_LIVE_PROMPT,
);
const scanPromptEl = bindPromptField(
  "scan-prompt", "scan-prompt-reset", "chatlm.scanPrompt", DEFAULT_SCAN_PROMPT,
);

async function liveDescribe() {
  if (liveBusy || !camStream) return;
  liveBusy = true;
  const t0 = performance.now();
  try {
    const b = await captureFrame(RES.vision, 0.65);
    if (!b) return;
    const prompt = (livePromptEl.value || "").trim() || DEFAULT_LIVE_PROMPT;
    const res = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          {
            role: "user",
            content: prompt,
            images: [b],
          },
        ],
        temperature: 0.2,
        max_tokens: 70,
        think: false,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    appendFeed(data.message.content.trim(), "info");
    setStat("s-live", `${Math.round(performance.now() - t0)} ms`);
  } catch (err) {
    appendFeed(`[ERR] ${err.message}`, "err");
    setStat("s-live", "err");
  } finally {
    liveBusy = false;
  }
}

function startLive() {
  if (liveTimer || !camStream) return;
  camLive.setAttribute("aria-pressed", "true");
  const myToken = ++liveToken;
  const tick = async () => {
    if (myToken !== liveToken) return;
    await liveDescribe();
    if (myToken === liveToken) {
      liveTimer = setTimeout(tick, parseInt(camInterval.value, 10) * 1000);
    }
  };
  liveTimer = setTimeout(tick, 0);
}

function stopLive() {
  liveToken++;
  if (liveTimer) {
    clearTimeout(liveTimer);
    liveTimer = null;
  }
  camLive.setAttribute("aria-pressed", "false");
}

function restartLive() {
  stopLive();
  startLive();
}

camLive.addEventListener("click", () => {
  if (liveTimer) stopLive();
  else startLive();
});

/* ---------- segmentation overlay (YOLO-World + MobileSAM) ---------- */
const trackInput = document.getElementById("track-input");
const trackToggle = document.getElementById("track-toggle");
const masksToggle = document.getElementById("masks-toggle");
// camCanvas / camLabels imported from camera.js
let trackTimer = null;
let trackBusy = false;
// User-intent flag: when true, AUTO scan will not auto-restart TRACK. Cleared
// when the user explicitly clicks TRACK on again.
let trackUserDisabled = false;
let masksOn = localStorage.getItem("chatlm.masks") === "1";
masksToggle.setAttribute("aria-pressed", masksOn ? "true" : "false");
function reconcileSegmentMode() {
  // SEGMENT on + TRACK on  -> masks applied to TRACK detections (in track loop)
  // SEGMENT on + TRACK off -> standalone FastSAM auto-segmentation loop
  // SEGMENT off            -> stop the standalone loop
  if (masksOn && !trackTimer && camStream) {
    if (!segallTimer) startSegall();
  } else {
    if (segallTimer) stopSegall();
  }
}
masksToggle.addEventListener("click", () => {
  masksOn = !masksOn;
  localStorage.setItem("chatlm.masks", masksOn ? "1" : "0");
  masksToggle.setAttribute("aria-pressed", masksOn ? "true" : "false");
  reconcileSegmentMode();
});

const COLORS = [
  ["#00f0ff", "rgba(0,240,255,0.22)"],
  ["#ff2bd6", "rgba(255,43,214,0.22)"],
  ["#39ff14", "rgba(57,255,20,0.22)"],
  ["#ffb000", "rgba(255,176,0,0.22)"],
];

function syncOverlayRect() {
  const vw = camVideo.videoWidth;
  const vh = camVideo.videoHeight;
  const wrap = camVideo.parentElement;
  if (!wrap) return;
  const wrapRect = wrap.getBoundingClientRect();
  let dispW = wrapRect.width;
  let dispH = wrapRect.height;
  let left = 0;
  let top = 0;
  if (vw && vh) {
    const videoAspect = vw / vh;
    const wrapAspect = wrapRect.width / wrapRect.height;
    if (videoAspect > wrapAspect) {
      dispW = wrapRect.width;
      dispH = wrapRect.width / videoAspect;
      top = (wrapRect.height - dispH) / 2;
    } else {
      dispH = wrapRect.height;
      dispW = wrapRect.height * videoAspect;
      left = (wrapRect.width - dispW) / 2;
    }
  }
  for (const el of [camCanvas, camLabels]) {
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.width = `${dispW}px`;
    el.style.height = `${dispH}px`;
  }
}

function clearOverlay() {
  const ctx = camCanvas.getContext("2d");
  ctx.clearRect(0, 0, camCanvas.width, camCanvas.height);
  camLabels.innerHTML = "";
}

// Shared overlay state so TRACK / POSE / FACE can all composite on the same canvas.
const overlay = { detect: null, pose: null, face: null, people: null, segall: null, bgsub: null, anime: null };
// AnimeGANv2 returns a full JPEG per frame; we keep a decoded ImageBitmap
// around so drawOverlay can redraw quickly without re-decoding.
let _animeBitmap = null;
function clearOverlayState(which) {
  if (which) overlay[which] = null;
  else Object.keys(overlay).forEach((k) => (overlay[k] = null));
}

function drawOverlay() {
  const srcs = [overlay.detect, overlay.pose, overlay.face, overlay.people, overlay.segall].filter(Boolean);
  if (!srcs.length) { clearOverlay(); return; }
  const cw = Math.max(...srcs.map((s) => s.w || 0));
  const ch = Math.max(...srcs.map((s) => s.h || 0));
  camCanvas.width = cw;
  camCanvas.height = ch;
  const ctx = camCanvas.getContext("2d");
  ctx.clearRect(0, 0, cw, ch);
  camLabels.innerHTML = "";
  // ANIME first = lowest layer — it's a full-frame replacement that other
  // overlays draw on top of.
  if (overlay.anime && _animeBitmap) ctx.drawImage(_animeBitmap, 0, 0, cw, ch);
  if (overlay.segall) _drawSegallOn(ctx, overlay.segall);
  if (overlay.bgsub)  _drawBgSubOn(ctx, overlay.bgsub);
  if (overlay.people) _drawPeopleOn(ctx, overlay.people);
  if (overlay.detect) _drawDetectionsOn(ctx, overlay.detect, cw, ch);
  if (overlay.pose)   _drawPoseOn(ctx, overlay.pose);
  if (overlay.face)   _drawFaceOn(ctx, overlay.face);
}

function _drawBgSubOn(ctx, data) {
  if (!data.polygons || !data.polygons.length) return;
  ctx.fillStyle = "rgba(255, 176, 0, 0.22)";   // amber
  ctx.strokeStyle = "rgba(255, 176, 0, 0.9)";
  ctx.lineWidth = 2;
  ctx.shadowColor = "#ffb000";
  ctx.shadowBlur = 10;
  for (const poly of data.polygons) {
    if (poly.length < 3) continue;
    ctx.beginPath();
    ctx.moveTo(poly[0][0], poly[0][1]);
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1]);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
}

function _drawSegallOn(ctx, data) {
  if (!data.polygons || !data.polygons.length) return;
  // Rotate through a rainbow-ish palette so adjacent regions are distinguishable.
  const hues = [200, 320, 140, 40, 280, 90, 350, 170, 60, 260];
  ctx.lineWidth = 1.2;
  for (let i = 0; i < data.polygons.length; i++) {
    const poly = data.polygons[i];
    if (poly.length < 3) continue;
    const hue = hues[i % hues.length];
    ctx.fillStyle = `hsla(${hue}, 90%, 55%, 0.22)`;
    ctx.strokeStyle = `hsla(${hue}, 95%, 65%, 0.75)`;
    ctx.beginPath();
    ctx.moveTo(poly[0][0], poly[0][1]);
    for (let j = 1; j < poly.length; j++) ctx.lineTo(poly[j][0], poly[j][1]);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
}

function _drawPeopleOn(ctx, data) {
  if (!data.polygons || !data.polygons.length) return;
  ctx.fillStyle = "rgba(57, 255, 20, 0.18)";  // neon green tint
  ctx.strokeStyle = "#39ff14";
  ctx.lineWidth = 2;
  ctx.shadowColor = "#39ff14";
  ctx.shadowBlur = 10;
  for (const poly of data.polygons) {
    if (poly.length < 3) continue;
    ctx.beginPath();
    ctx.moveTo(poly[0][0], poly[0][1]);
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1]);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
}

function _convexHull(points) {
  // Andrew's monotone chain.
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function _drawPoseOn(ctx, data) {
  if (!data.people || !data.people.length) return;
  const skeleton = [[5,6],[5,11],[6,12],[11,12],[5,7],[7,9],[6,8],[8,10],[11,13],[13,15],[12,14],[14,16],[0,1],[0,2],[1,3],[2,4]];
  for (const p of data.people) {
    const kp = p.keypoints;
    const kc = p.kp_conf || [];
    // Body silhouette = convex hull of confident keypoints, semi-transparent magenta.
    const visible = kp.filter((_, i) => (kc[i] || 1) >= 0.3);
    if (visible.length >= 3) {
      const hull = _convexHull(visible);
      ctx.fillStyle = "rgba(255, 43, 214, 0.16)";
      ctx.strokeStyle = "rgba(255, 43, 214, 0.55)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(hull[0][0], hull[0][1]);
      for (let i = 1; i < hull.length; i++) ctx.lineTo(hull[i][0], hull[i][1]);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    // Skeleton lines + joint dots.
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#ff2bd6";
    ctx.fillStyle = "#00f0ff";
    ctx.shadowColor = "#00f0ff";
    ctx.shadowBlur = 8;
    for (const [a, b] of skeleton) {
      if ((kc[a] || 1) < 0.3 || (kc[b] || 1) < 0.3) continue;
      ctx.beginPath();
      ctx.moveTo(kp[a][0], kp[a][1]); ctx.lineTo(kp[b][0], kp[b][1]);
      ctx.stroke();
    }
    for (let i = 0; i < kp.length; i++) {
      if ((kc[i] || 1) < 0.3) continue;
      ctx.beginPath();
      ctx.arc(kp[i][0], kp[i][1], 4, 0, 2 * Math.PI);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
    // Stable #id label near the head (nose keypoint index 0).
    if (p.id != null && (kc[0] || 1) >= 0.3) {
      const [hx, hy] = kp[0];
      const label = `#${p.id}`;
      ctx.font = "bold 14px 'Orbitron','Share Tech Mono',monospace";
      const tw = ctx.measureText(label).width + 8;
      ctx.fillStyle = "rgba(5,6,11,0.85)";
      ctx.fillRect(hx - tw / 2, hy - 34, tw, 20);
      ctx.fillStyle = "#ff2bd6";
      ctx.shadowColor = "#ff2bd6";
      ctx.shadowBlur = 6;
      ctx.textAlign = "center";
      ctx.fillText(label, hx, hy - 20);
      ctx.textAlign = "start";
      ctx.shadowBlur = 0;
    }
  }
}

function _drawHeadPoseCube(ctx, f) {
  if (f.yaw == null) return;
  // OpenCV solvePnP returns yaw/roll with the opposite handedness of our
  // canvas draw space (OpenCV: Y-down, Z-forward; canvas: Y-down, no Z).
  // Negate yaw + roll so the cube rotates *with* the head, not against it.
  const yaw   = (-f.yaw   * Math.PI) / 180;
  const pitch = ( f.pitch * Math.PI) / 180;
  const roll  = (-f.roll  * Math.PI) / 180;
  // Wrap the cube around the head: centre it on the face box and size it
  // so the unrotated cube just encloses the box.
  const [x1, y1, x2, y2] = f.box;
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const size = Math.max(x2 - x1, y2 - y1) * 0.55;
  const cube = [
    [-1,-1,-1],[ 1,-1,-1],[ 1, 1,-1],[-1, 1,-1],
    [-1,-1, 1],[ 1,-1, 1],[ 1, 1, 1],[-1, 1, 1],
  ].map(([x, y, z]) => [x * size, y * size, z * size]);
  const edges = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
  const sy = Math.sin(yaw),   cy_ = Math.cos(yaw);
  const sp = Math.sin(pitch), cp = Math.cos(pitch);
  const sr = Math.sin(roll),  cr = Math.cos(roll);
  const projected = cube.map(([x, y, z]) => {
    // Rotate X (pitch) then Y (yaw) then Z (roll).
    let y1 = y * cp - z * sp, z1 = y * sp + z * cp;
    let x2 = x * cy_ + z1 * sy, z2 = -x * sy + z1 * cy_;
    let x3 = x2 * cr - y1 * sr, y3 = x2 * sr + y1 * cr;
    // Orthographic projection + slight perspective.
    const scale = 1 + z2 / 500;
    return [cx + x3 * scale, cy + y3 * scale];
  });
  ctx.lineWidth = 1.8;
  ctx.strokeStyle = "#00f0ff";
  ctx.shadowColor = "#00f0ff";
  ctx.shadowBlur = 6;
  for (const [a, b] of edges) {
    ctx.beginPath();
    ctx.moveTo(projected[a][0], projected[a][1]);
    ctx.lineTo(projected[b][0], projected[b][1]);
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
  // Numeric readout.
  ctx.font = "10px 'Share Tech Mono',monospace";
  ctx.fillStyle = "rgba(5,6,11,0.8)";
  const label = `y${f.yaw|0}° p${f.pitch|0}° r${f.roll|0}°`;
  const tw = ctx.measureText(label).width + 6;
  const labelY = Math.min(ctx.canvas.height - 14, y2 + 4);
  ctx.fillRect(cx - tw / 2, labelY, tw, 14);
  ctx.fillStyle = "#00f0ff";
  ctx.textAlign = "center";
  ctx.fillText(label, cx, labelY + 10);
  ctx.textAlign = "start";
}

function _drawFaceOn(ctx, data) {
  if (!data.faces || !data.faces.length) return;
  for (const f of data.faces) {
    // Convex hull of the mesh = face silhouette, semi-transparent green fill.
    if (f.landmarks && f.landmarks.length >= 3) {
      const hull = _convexHull(f.landmarks);
      ctx.fillStyle = "rgba(57, 255, 20, 0.12)";
      ctx.strokeStyle = "rgba(57, 255, 20, 0.45)";
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(hull[0][0], hull[0][1]);
      for (let i = 1; i < hull.length; i++) ctx.lineTo(hull[i][0], hull[i][1]);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    // Mesh landmark dots.
    ctx.fillStyle = "#39ff14";
    ctx.shadowColor = "#39ff14";
    ctx.shadowBlur = 4;
    for (const [x, y] of f.landmarks) {
      ctx.beginPath();
      ctx.arc(x, y, 1.2, 0, 2 * Math.PI);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
  }
  ctx.font = "16px 'Orbitron','Share Tech Mono',monospace";
  for (const f of data.faces) {
    const parts = [];
    if (f.id != null) parts.push(`#${f.id}`);
    if (f.emotion) parts.push(`${f.emotion.toUpperCase()} ${(f.emotion_score * 100) | 0}%`);
    if (parts.length) {
      const [x1, y1] = f.box;
      const label = parts.join(" ");
      const tw = ctx.measureText(label).width + 10;
      ctx.fillStyle = "rgba(5,6,11,0.85)";
      ctx.fillRect(x1, Math.max(y1 - 22, 0), tw, 22);
      ctx.fillStyle = "#ff2bd6";
      ctx.shadowColor = "#ff2bd6";
      ctx.shadowBlur = 6;
      ctx.fillText(label, x1 + 5, Math.max(y1 - 6, 16));
      ctx.shadowBlur = 0;
    }
    if (cubeOn) _drawHeadPoseCube(ctx, f);
  }
}

let cubeOn = localStorage.getItem("chatlm.cube") === "1";
const cubeBtnEl = document.getElementById("btn-cube");
if (cubeBtnEl) {
  cubeBtnEl.setAttribute("aria-pressed", cubeOn ? "true" : "false");
  cubeBtnEl.addEventListener("click", () => {
    cubeOn = !cubeOn;
    cubeBtnEl.setAttribute("aria-pressed", cubeOn ? "true" : "false");
    localStorage.setItem("chatlm.cube", cubeOn ? "1" : "0");
    if (cubeOn && !faceTimer && camStream) startFace();
    drawOverlay();
  });
}

function drawDetections(result) {
  overlay.detect = result;
  drawOverlay();
}

function _drawDetectionsOn(ctx, result, w, h) {
  const { polygons, boxes, labels, confidences } = result;
  const count = Math.max(polygons?.length || 0, boxes?.length || 0);
  for (let idx = 0; idx < count; idx++) {
    const [stroke, fill] = COLORS[idx % COLORS.length];
    const poly = polygons?.[idx];
    const box = boxes?.[idx];
    ctx.lineWidth = 3;
    ctx.strokeStyle = stroke;
    ctx.shadowColor = stroke;
    ctx.shadowBlur = 8;

    if (poly && poly.length >= 3) {
      ctx.beginPath();
      ctx.moveTo(poly[0][0], poly[0][1]);
      for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1]);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.stroke();
      // Also draw a dim dashed YOLO bbox alongside the mask so the user sees
      // both the raw detection rectangle and the refined segmentation.
      if (box) {
        const [x1, y1, x2, y2] = box;
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 0.45;
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = stroke;
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        ctx.lineWidth = 3;
      }
    } else if (box) {
      const [x1, y1, x2, y2] = box;
      ctx.fillStyle = fill;
      ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    }
    ctx.shadowBlur = 0;

    const src = poly && poly.length ? poly : [[box[0], box[1]]];
    let minX = Infinity, minY = Infinity;
    for (const [x, y] of src) { if (x < minX) minX = x; if (y < minY) minY = y; }
    const lbl = document.createElement("div");
    lbl.className = "label";
    lbl.style.left = (minX / w) * 100 + "%";
    lbl.style.top = (minY / h) * 100 + "%";
    lbl.style.borderColor = stroke;
    lbl.style.color = stroke;
    lbl.style.textShadow = `0 0 6px ${stroke}`;
    const conf = confidences[idx] != null ? ` ${(confidences[idx] * 100).toFixed(0)}%` : "";
    const id = result.ids?.[idx];
    const idTag = id != null && id >= 0 ? `#${id} ` : "";
    lbl.textContent = `${idTag}${(labels[idx] || "?").toUpperCase()}${conf}`;
    camLabels.appendChild(lbl);
  }
}

async function trackOnce() {
  if (trackBusy || !camStream) return;
  const prompt = trackInput.value.trim();
  if (!prompt) return;
  const myToken = trackToken;
  trackBusy = true;
  try {
    const b = await captureFrame(RES.detect, 0.7);
    if (!b) return;
    const res = await fetch("/detect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: b,
        prompt,
        masks: masksOn,
        imgsz: RES.detect,
        track: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    if (myToken !== trackToken) return;  // TRACK stopped mid-flight; discard.
    drawDetections(data);
    const t = data.timings_ms || {};
    if (t.detect != null) setStat("s-yolo", `${Math.round(t.detect)} ms`);
    if (t.segment != null) setStat("s-sam", `${Math.round(t.segment)} ms`);
    else if (!masksOn) setStat("s-sam", "off");
  } catch (err) {
    console.warn("track error", err);
    appendFeed(`[DETECT ERR] ${err.message}`, "err");
    setStat("s-yolo", "err");
  } finally {
    trackBusy = false;
  }
}

function startTrack() {
  if (trackTimer || !camStream) return;
  const prompt = trackInput.value.trim();
  if (!prompt) {
    trackInput.focus();
    return;
  }
  trackToggle.setAttribute("aria-pressed", "true");
  document.body.classList.add("track-armed");
  // TRACK takes over the mask pipeline; stop the standalone segment-all loop.
  if (segallTimer) stopSegall();
  const myToken = ++trackToken;
  const tick = async () => {
    if (myToken !== trackToken) return;
    await trackOnce();
    if (myToken === trackToken) {
      trackTimer = setTimeout(tick, 20);
    }
  };
  trackTimer = setTimeout(tick, 0);
}

function stopTrack() {
  trackToken++;
  if (trackTimer) clearTimeout(trackTimer);
  trackTimer = null;
  trackToggle.setAttribute("aria-pressed", "false");
  document.body.classList.remove("track-armed");
  // Drop the detection overlay (boxes/polygons/labels) and also forget the
  // per-pipeline latency so the telemetry tiles don't show stale numbers.
  clearOverlayState("detect");
  drawOverlay();
  setStat("s-yolo", "--");
  setStat("s-sam", "--");
  // If SEGMENT is still requested, fall back to standalone auto-segmentation.
  reconcileSegmentMode();
}

trackToggle.addEventListener("click", () => {
  if (trackTimer || document.body.classList.contains("track-armed")) {
    stopTrack();
    trackUserDisabled = true;  // keep TRACK off even if AUTO keeps producing chips
    return;
  }
  // User explicitly turning TRACK on → clear the disabled intent.
  trackUserDisabled = false;
  document.body.classList.add("track-armed");
  trackToggle.setAttribute("aria-pressed", "true");
  if (trackInput.value.trim() && camStream) startTrack();
  else trackInput.focus();
});
trackInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    if (!trackTimer) startTrack();
  }
});

/* ---------- scan frame (Gemma → object chips) ---------- */
const scanBtn = document.getElementById("cam-scan");
const scanChips = document.getElementById("scan-chips");
const selected = new Set();

function chipsFromInput() {
  return new Set(
    trackInput.value
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

function syncInputFromSelection() {
  trackInput.value = Array.from(selected).join(", ");
}

let autoTrackPrimed = false;
// Tags the user added manually — kept across AUTO scans and never purged by
// the "drop stale selections" logic below.
const customTags = new Set(
  JSON.parse(localStorage.getItem("chatlm.customTags") || "[]"),
);
function persistCustomTags() {
  localStorage.setItem("chatlm.customTags", JSON.stringify([...customTags]));
}

function makeChip(tag, opts = {}) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "chip-btn" + (opts.custom ? " custom" : "");
  btn.textContent = tag;
  const on = selected.has(tag);
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  btn.addEventListener("click", (e) => {
    if (e.target.classList.contains("x")) return;
    const nowOn = btn.getAttribute("aria-pressed") !== "true";
    btn.setAttribute("aria-pressed", nowOn ? "true" : "false");
    if (nowOn) selected.add(tag);
    else selected.delete(tag);
    syncInputFromSelection();
    if (selected.size && !trackTimer && camStream) startTrack();
    if (!selected.size && trackTimer) stopTrack();
  });
  if (opts.custom) {
    const rm = document.createElement("span");
    rm.className = "x";
    rm.textContent = "×";
    rm.title = "Remove custom tag";
    rm.addEventListener("click", (e) => {
      e.stopPropagation();
      customTags.delete(tag);
      selected.delete(tag);
      persistCustomTags();
      syncInputFromSelection();
      if (!selected.size && trackTimer) stopTrack();
      renderChips(lastScanObjects);
    });
    btn.appendChild(rm);
  }
  return btn;
}

let lastScanObjects = [];

function renderChips(objects) {
  lastScanObjects = objects.slice();
  scanChips.innerHTML = "";
  // Everything visible as a chip is tracked and shown in the input.
  selected.clear();
  for (const o of objects) selected.add(o);
  for (const t of customTags) selected.add(t);
  autoTrackPrimed = true;

  syncInputFromSelection();
  // Only auto-start TRACK if the user hasn't explicitly turned it off.
  if (selected.size && !trackTimer && camStream && !trackUserDisabled) startTrack();
  if (!selected.size && trackTimer) stopTrack();

  if (!objects.length && !customTags.size) {
    scanChips.hidden = true;
    return;
  }
  scanChips.hidden = false;
  for (const o of customTags) {
    scanChips.appendChild(makeChip(o, { custom: true }));
  }
  for (const o of objects) {
    if (customTags.has(o)) continue;
    scanChips.appendChild(makeChip(o));
  }
}

async function scanOnce() {
  if (!camStream) {
    appendFeed("[SCAN] camera not active", "err");
    return;
  }
  if (scanBusy) {
    // Another scan (probably AUTO) is already in flight — flash the button
    // so the user sees their click was noticed.
    scanBtn.classList.add("flash");
    setTimeout(() => scanBtn.classList.remove("flash"), 300);
    return;
  }
  scanBusy = true;
  scanBtn.disabled = true;
  scanBtn.classList.add("busy");
  try {
    const b = await captureFrame(RES.vision, 0.8);
    if (!b) return;
    const res = await fetch("/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: b,
        max_objects: 6,
        prompt: (scanPromptEl.value || "").trim() || undefined,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderChips(data.objects || []);
    const tags = (data.objects || []).join(", ") || "—";
    appendFeed(data.description ? `${data.description} · ${tags}` : tags, "scan");
    if (data.latency_ms != null) setStat("s-scan", `${data.latency_ms} ms`);
  } catch (err) {
    appendFeed(`[SCAN ERR] ${err.message}`, "err");
    setStat("s-scan", "err");
  } finally {
    scanBusy = false;
    scanBtn.disabled = false;
    scanBtn.classList.remove("busy");
  }
}

scanBtn.addEventListener("click", () => scanOnce());

/* ---------- custom TRACK tags ---------- */
const customTagInput = document.getElementById("custom-tag-input");
const customTagAddBtn = document.getElementById("custom-tag-add");

function addCustomTag(raw) {
  const tag = (raw || "").trim().toLowerCase();
  if (!tag) return;
  if (customTags.has(tag)) return;
  customTags.add(tag);
  selected.add(tag);
  persistCustomTags();
  syncInputFromSelection();
  renderChips(lastScanObjects);
  if (camStream && !trackTimer) startTrack();
}

customTagAddBtn.addEventListener("click", () => {
  addCustomTag(customTagInput.value);
  customTagInput.value = "";
  customTagInput.focus();
});
customTagInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addCustomTag(customTagInput.value);
    customTagInput.value = "";
  }
});

// If there are saved custom tags from a previous session, render them immediately.
if (customTags.size) {
  for (const t of customTags) selected.add(t);
  syncInputFromSelection();
  renderChips([]);
}

/* ---------- inpaint / REPLACE ---------- */
const replaceInput = document.getElementById("replace-input");
const replaceBtn = document.getElementById("replace-btn");

async function runReplace() {
  if (!camStream) {
    appendFeed("[REPLACE] camera not active", "err");
    return;
  }
  const prompt = (replaceInput.value || "").trim();
  if (!prompt) {
    replaceInput.focus();
    return;
  }
  if (!selected.size) {
    appendFeed("[REPLACE] select at least one chip first", "err");
    return;
  }
  replaceBtn.disabled = true;
  const origLabel = replaceBtn.textContent;
  replaceBtn.textContent = "REPLACING…";
  appendFeed(`[REPLACE] "${prompt}" on: ${[...selected].join(", ")}`, "scan");
  try {
    const imageB64 = await captureFrame(FRAME_SIZE, 0.9);
    if (!imageB64) throw new Error("no frame captured");
    // Fresh detect call with masks on, using currently-selected targets.
    const detRes = await fetch("/detect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: imageB64,
        prompt: [...selected].join(", "),
        masks: true,
        imgsz: FRAME_SIZE,
      }),
    });
    if (!detRes.ok) throw new Error(`detect failed: ${detRes.status}`);
    const det = await detRes.json();
    if (!det.polygons?.length && !det.boxes?.length) {
      appendFeed(`[REPLACE] nothing matched "${[...selected].join(", ")}" in current frame`, "err");
      return;
    }

    const inpaintRes = await fetch("/inpaint", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: imageB64,
        prompt,
        polygons: det.polygons?.length ? det.polygons : undefined,
        boxes: det.boxes?.length && !det.polygons?.length ? det.boxes : undefined,
        width: det.w,
        height: det.h,
        steps: 4,
        guidance: 4.0,
        max_size: FRAME_SIZE,
        feather: 11,
      }),
    });
    if (!inpaintRes.ok) {
      const errText = await inpaintRes.text();
      throw new Error(`inpaint failed: ${errText.slice(0, 200)}`);
    }
    const out = await inpaintRes.json();
    showInpaintResult(out, prompt);
    setStat("s-op-replace", `${out.latency_ms} ms`);
    appendFeed(
      `[REPLACE] done · ${out.latency_ms} ms · ${out.width}×${out.height} · steps ${out.steps}`,
      "scan",
    );
  } catch (err) {
    setStat("s-op-replace", "err");
    appendFeed(`[REPLACE ERR] ${err.message}`, "err");
  } finally {
    replaceBtn.disabled = false;
    replaceBtn.textContent = origLabel;
  }
}

function showInpaintResult(out, prompt) {
  const card = document.createElement("div");
  card.className = "inpaint-result";
  const head = document.createElement("div");
  head.className = "head";
  const label = document.createElement("span");
  label.textContent = `// REPLACED · "${prompt.slice(0, 40)}"`;
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "✕";
  close.addEventListener("click", () => card.remove());
  head.appendChild(label);
  head.appendChild(close);
  const img = document.createElement("img");
  img.src = `data:image/jpeg;base64,${out.image}`;
  card.appendChild(head);
  card.appendChild(img);
  camFeedBody.insertBefore(card, camFeedBody.firstChild);
  camFeedBody.scrollTop = 0;
}

replaceBtn.addEventListener("click", runReplace);
replaceInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    runReplace();
  }
});

/* ---------- img2img / GENERATE (full-frame) ---------- */
const genInput = document.getElementById("gen-input");
const genBtn = document.getElementById("gen-btn");
const genStrength = document.getElementById("gen-strength");
const genStrengthVal = document.getElementById("gen-strength-val");
const savedStrength = localStorage.getItem("chatlm.genStrength");
if (savedStrength) genStrength.value = savedStrength;
genStrengthVal.textContent = parseFloat(genStrength.value).toFixed(2);
genStrength.addEventListener("input", () => {
  genStrengthVal.textContent = parseFloat(genStrength.value).toFixed(2);
  localStorage.setItem("chatlm.genStrength", genStrength.value);
});

async function runGenerate() {
  if (!camStream) {
    appendFeed("[GEN] camera not active", "err");
    return;
  }
  const prompt = (genInput.value || "").trim();
  if (!prompt) {
    genInput.focus();
    return;
  }
  genBtn.disabled = true;
  const orig = genBtn.textContent;
  genBtn.textContent = "GENERATING…";
  const strength = parseFloat(genStrength.value);
  appendFeed(`[GEN] "${prompt}" · strength ${strength.toFixed(2)}`, "scan");
  try {
    const imageB64 = await captureFrame(FRAME_SIZE, 0.9);
    if (!imageB64) throw new Error("no frame captured");
    const res = await fetch("/img2img", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: imageB64, prompt, strength, max_size: 640 }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`HTTP ${res.status}: ${err.slice(0, 200)}`);
    }
    const out = await res.json();
    showGenResult(out, prompt);
    setStat("s-op-gen", `${out.latency_ms} ms`);
    appendFeed(
      `[GEN] done · ${out.latency_ms} ms · ${out.width}×${out.height} · steps ${out.steps}`,
      "scan",
    );
  } catch (err) {
    appendFeed(`[GEN ERR] ${err.message}`, "err");
    setStat("s-op-gen", "err");
  } finally {
    genBtn.disabled = false;
    genBtn.textContent = orig;
  }
}

function showGenResult(out, prompt) {
  const card = document.createElement("div");
  card.className = "inpaint-result";
  card.innerHTML = `
    <div class="head">
      <span>// GENERATED · "${prompt.slice(0, 40)}" · s ${out.strength.toFixed(2)}</span>
      <button type="button">✕</button>
    </div>`;
  card.querySelector("button").addEventListener("click", () => card.remove());
  const img = document.createElement("img");
  img.src = `data:image/jpeg;base64,${out.image}`;
  card.appendChild(img);
  camFeedBody.insertBefore(card, camFeedBody.firstChild);
  camFeedBody.scrollTop = 0;
}

genBtn.addEventListener("click", runGenerate);
genInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    runGenerate();
  }
});

/* ---------- extras: POSE · DEPTH · CUTOUT ---------- */

function _feedCard(headLabel, headColor, imgB64) {
  const card = document.createElement("div");
  card.className = "inpaint-result";
  card.innerHTML = `
    <div class="head" style="color:${headColor}">
      <span>${headLabel}</span>
      <button type="button">✕</button>
    </div>`;
  card.querySelector(".head button").addEventListener("click", () => card.remove());
  const img = document.createElement("img");
  img.src = `data:image/${imgB64.startsWith("iVBOR") ? "png" : "jpeg"};base64,${imgB64}`;
  card.appendChild(img);
  camFeedBody.insertBefore(card, camFeedBody.firstChild);
  camFeedBody.scrollTop = 0;
}

const ONESHOT_STAT = {
  POSE: "s-op-pose",
  DEPTH: "s-op-depth",
  CUTOUT: "s-op-cutout",
  OCR: "s-op-ocr",
  FACE: "s-op-face",
};

async function runOneShot(path, label, extraBody = {}, draw) {
  if (!camStream) {
    appendFeed(`[${label}] camera not active`, "err");
    return;
  }
  const btn = document.activeElement;
  if (btn && btn.tagName === "BUTTON") btn.disabled = true;
  try {
    const imageB64 = await captureFrame(FRAME_SIZE, 0.8);
    if (!imageB64) throw new Error("no frame");
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: imageB64, ...extraBody }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0,200)}`);
    const data = await res.json();
    appendFeed(`[${label}] ${data.latency_ms} ms`, "scan");
    const statId = ONESHOT_STAT[label];
    if (statId && data.latency_ms != null) setStat(statId, `${data.latency_ms} ms`);
    draw(data, imageB64);
  } catch (err) {
    appendFeed(`[${label} ERR] ${err.message}`, "err");
    const statId = ONESHOT_STAT[label];
    if (statId) setStat(statId, "err");
  } finally {
    if (btn && btn.tagName === "BUTTON") btn.disabled = false;
  }
}

document.getElementById("btn-depth").addEventListener("click", () =>
  runOneShot("/depth", "DEPTH", {}, (data) =>
    _feedCard("// DEPTH", "var(--cyan)", data.image)));

document.getElementById("btn-cutout").addEventListener("click", () =>
  runOneShot("/remove-bg", "CUTOUT", { return_mask: false }, (data) =>
    _feedCard("// CUTOUT", "var(--green)", data.image)));

document.getElementById("btn-ocr").addEventListener("click", () =>
  runOneShot("/ocr", "OCR", {}, (data, origB64) => {
    const c = document.createElement("canvas");
    c.width = data.w; c.height = data.h;
    const ctx = c.getContext("2d");
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, data.w, data.h);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#00f0ff";
      ctx.fillStyle = "rgba(5,6,11,0.7)";
      ctx.font = "14px 'Share Tech Mono', monospace";
      for (const it of data.items) {
        const [x1, y1, x2, y2] = it.box;
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
        const label = `${it.text} ${(it.confidence * 100).toFixed(0)}%`;
        const w = ctx.measureText(label).width + 6;
        ctx.fillRect(x1, Math.max(y1 - 18, 0), w, 18);
        ctx.fillStyle = "#00f0ff";
        ctx.fillText(label, x1 + 3, Math.max(y1 - 5, 12));
        ctx.fillStyle = "rgba(5,6,11,0.7)";
      }
      const out = c.toDataURL("image/jpeg", 0.88).split(",")[1];
      _feedCard(`// OCR · ${data.items.length} lines`, "var(--cyan)", out);
    };
    img.src = `data:image/jpeg;base64,${origB64}`;
  }));

/* ---------- live POSE / FACE overlay loops ---------- */
let poseTimer = null, poseToken = 0, poseBusy = false;
let faceTimer = null, faceToken = 0, faceBusy = false;
const poseBtnEl = document.getElementById("btn-pose");
const faceBtnEl = document.getElementById("btn-face");

async function poseTick() {
  if (poseBusy || !camStream) return;
  const myToken = poseToken;
  poseBusy = true;
  try {
    const b = await captureFrame(RES.detect, 0.75);
    if (!b) return;
    const res = await fetch("/pose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: b }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (myToken !== poseToken) return;
    overlay.pose = data;
    drawOverlay();
    if (data.latency_ms != null) setStat("s-op-pose", `${data.latency_ms} ms`);
  } catch (err) {
    console.warn("pose loop", err);
    setStat("s-op-pose", "err");
  } finally {
    poseBusy = false;
  }
}
function startPose() {
  if (poseTimer || !camStream) return;
  poseBtnEl.setAttribute("aria-pressed", "true");
  const t = ++poseToken;
  const loop = async () => {
    if (t !== poseToken) return;
    await poseTick();
    if (t === poseToken) poseTimer = setTimeout(loop, 20);
  };
  poseTimer = setTimeout(loop, 0);
}
function stopPose() {
  poseToken++;
  if (poseTimer) clearTimeout(poseTimer);
  poseTimer = null;
  poseBtnEl.setAttribute("aria-pressed", "false");
  clearOverlayState("pose");
  drawOverlay();
  setStat("s-op-pose", "--");
}

async function faceTick() {
  if (faceBusy || !camStream) return;
  const myToken = faceToken;
  faceBusy = true;
  try {
    const b = await captureFrame(RES.detect, 0.75);
    if (!b) return;
    const res = await fetch("/face", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: b, emotion: true, head_pose: true }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (myToken !== faceToken) return;
    overlay.face = data;
    drawOverlay();
    if (data.latency_ms != null) setStat("s-op-face", `${data.latency_ms} ms`);
  } catch (err) {
    console.warn("face loop", err);
    setStat("s-op-face", "err");
  } finally {
    faceBusy = false;
  }
}
function startFace() {
  if (faceTimer || !camStream) return;
  faceBtnEl.setAttribute("aria-pressed", "true");
  const t = ++faceToken;
  const loop = async () => {
    if (t !== faceToken) return;
    await faceTick();
    if (t === faceToken) faceTimer = setTimeout(loop, 20);
  };
  faceTimer = setTimeout(loop, 0);
}
function stopFace() {
  faceToken++;
  if (faceTimer) clearTimeout(faceTimer);
  faceTimer = null;
  faceBtnEl.setAttribute("aria-pressed", "false");
  clearOverlayState("face");
  drawOverlay();
  setStat("s-op-face", "--");
}

poseBtnEl.addEventListener("click", () => (poseTimer ? stopPose() : startPose()));
faceBtnEl.addEventListener("click", () => (faceTimer ? stopFace() : startFace()));

/* ---------- live PEOPLE segmentation (MediaPipe Selfie, ~10ms) ---------- */
let peopleTimer = null, peopleToken = 0, peopleBusy = false;
const peopleBtnEl = document.getElementById("btn-people");

async function peopleTick() {
  if (peopleBusy || !camStream) return;
  const myToken = peopleToken;
  peopleBusy = true;
  try {
    const b = await captureFrame(RES.segment, 0.75);
    if (!b) return;
    const res = await fetch("/segment-people", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: b }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (myToken !== peopleToken) return;
    overlay.people = data;
    drawOverlay();
    if (data.latency_ms != null) setStat("s-op-people", `${data.latency_ms} ms`);
  } catch (err) {
    console.warn("people loop", err);
    setStat("s-op-people", "err");
  } finally {
    peopleBusy = false;
  }
}
function startPeople() {
  if (peopleTimer || !camStream) return;
  peopleBtnEl.setAttribute("aria-pressed", "true");
  const t = ++peopleToken;
  const loop = async () => {
    if (t !== peopleToken) return;
    await peopleTick();
    if (t === peopleToken) peopleTimer = setTimeout(loop, 10);
  };
  peopleTimer = setTimeout(loop, 0);
}
function stopPeople() {
  peopleToken++;
  if (peopleTimer) clearTimeout(peopleTimer);
  peopleTimer = null;
  peopleBtnEl.setAttribute("aria-pressed", "false");
  clearOverlayState("people");
  drawOverlay();
  setStat("s-op-people", "--");
}
peopleBtnEl.addEventListener("click", () => (peopleTimer ? stopPeople() : startPeople()));

/* ---------- BG-SUB (OpenCV MOG2 background subtraction, ~5ms) ---------- */
let bgsubTimer = null, bgsubToken = 0, bgsubBusy = false, bgsubNeedsReset = true;
const bgsubBtnEl = document.getElementById("btn-bgsub");

async function bgsubTick() {
  if (bgsubBusy || !camStream) return;
  const myToken = bgsubToken;
  bgsubBusy = true;
  try {
    const b = await captureFrame(RES.segment, 0.75);
    if (!b) return;
    const res = await fetch("/bg-sub", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: b, reset: bgsubNeedsReset }),
    });
    bgsubNeedsReset = false;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (myToken !== bgsubToken) return;
    overlay.bgsub = data;
    drawOverlay();
    if (data.latency_ms != null) setStat("s-op-bgsub", `${data.latency_ms} ms`);
  } catch (err) {
    console.warn("bgsub loop", err);
    setStat("s-op-bgsub", "err");
  } finally {
    bgsubBusy = false;
  }
}

function startBgSub() {
  if (bgsubTimer || !camStream) return;
  bgsubBtnEl.setAttribute("aria-pressed", "true");
  bgsubNeedsReset = true;  // fresh background model on every start
  const t = ++bgsubToken;
  const loop = async () => {
    if (t !== bgsubToken) return;
    await bgsubTick();
    if (t === bgsubToken) bgsubTimer = setTimeout(loop, 15);
  };
  bgsubTimer = setTimeout(loop, 0);
}
function stopBgSub() {
  bgsubToken++;
  if (bgsubTimer) clearTimeout(bgsubTimer);
  bgsubTimer = null;
  bgsubBtnEl.setAttribute("aria-pressed", "false");
  clearOverlayState("bgsub");
  drawOverlay();
  setStat("s-op-bgsub", "--");
}
bgsubBtnEl.addEventListener("click", () => (bgsubTimer ? stopBgSub() : startBgSub()));

/* ---------- ANIME live stylization (AnimeGANv2, ~110ms) ---------- */
let animeTimer = null, animeToken = 0, animeBusy = false;
const animeBtnEl = document.getElementById("btn-anime");

async function animeTick() {
  if (animeBusy || !camStream) return;
  const myToken = animeToken;
  animeBusy = true;
  try {
    const b = await captureFrame(384, 0.8);  // model wants square-ish, 384 is the sweet spot
    if (!b) return;
    const res = await fetch("/anime", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: b, size: 384 }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (myToken !== animeToken) return;
    // Decode the stylised JPEG once per response into an ImageBitmap so the
    // next drawOverlay tick can paint it instantly.
    try {
      const blob = await (await fetch(`data:image/jpeg;base64,${data.image}`)).blob();
      _animeBitmap = await createImageBitmap(blob);
    } catch {
      _animeBitmap = null;
    }
    overlay.anime = { w: data.width, h: data.height };
    drawOverlay();
    if (data.latency_ms != null) setStat("s-op-anime", `${data.latency_ms} ms`);
  } catch (err) {
    console.warn("anime loop", err);
    setStat("s-op-anime", "err");
  } finally {
    animeBusy = false;
  }
}

function startAnime() {
  if (animeTimer || !camStream) return;
  animeBtnEl.setAttribute("aria-pressed", "true");
  const t = ++animeToken;
  const loop = async () => {
    if (t !== animeToken) return;
    await animeTick();
    if (t === animeToken) animeTimer = setTimeout(loop, 20);
  };
  animeTimer = setTimeout(loop, 0);
}
function stopAnime() {
  animeToken++;
  if (animeTimer) clearTimeout(animeTimer);
  animeTimer = null;
  animeBtnEl.setAttribute("aria-pressed", "false");
  _animeBitmap = null;
  clearOverlayState("anime");
  drawOverlay();
  setStat("s-op-anime", "--");
}
animeBtnEl.addEventListener("click", () => (animeTimer ? stopAnime() : startAnime()));

/* ---------- AVATAR (canvas cartoon face driven by head-pose + face mesh) ---------- */
let avatarOn = false;
const avatarBtnEl = document.getElementById("btn-avatar");

function _mouthOpenness(landmarks) {
  // MediaPipe face mesh indices for upper-lip (13) and lower-lip (14) inner centre.
  if (!landmarks || landmarks.length < 468) return 0;
  const up = landmarks[13];
  const lo = landmarks[14];
  const left = landmarks[61], right = landmarks[291];
  const mouthHeight = Math.abs(lo[1] - up[1]);
  const mouthWidth = Math.abs(right[0] - left[0]) || 1;
  return Math.min(1, mouthHeight / (mouthWidth * 0.45));
}

function _drawAvatar(ctx, f, w, h) {
  const yaw = ((f.yaw ?? 0) * Math.PI) / 180;
  const pitch = ((f.pitch ?? 0) * Math.PI) / 180;
  const roll = ((f.roll ?? 0) * Math.PI) / 180;
  const [x1, y1, x2, y2] = f.box;
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const r = Math.max(30, (x2 - x1) * 0.55);

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(roll);
  // squash horizontally by yaw, vertically by pitch (cheap pseudo-3D)
  ctx.scale(Math.cos(yaw) * 0.85 + 0.15, Math.cos(pitch) * 0.85 + 0.15);

  // Face
  const grad = ctx.createRadialGradient(0, -r * 0.1, r * 0.2, 0, 0, r);
  grad.addColorStop(0, "#ffe6c7");
  grad.addColorStop(1, "#e0b080");
  ctx.fillStyle = grad;
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(0, 0, r * 0.85, r, 0, 0, 2 * Math.PI);
  ctx.fill();
  ctx.stroke();

  // Eyes — shift horizontally a tiny bit with yaw so gaze tracks head
  const eyeOffX = -Math.sin(yaw) * 6;
  const eyeOffY = -Math.sin(pitch) * 6;
  for (const side of [-1, 1]) {
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.ellipse(side * r * 0.32, -r * 0.1, r * 0.15, r * 0.18, 0, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#2b1a0a";
    ctx.beginPath();
    ctx.arc(side * r * 0.32 + eyeOffX, -r * 0.1 + eyeOffY, r * 0.06, 0, 2 * Math.PI);
    ctx.fill();
  }

  // Mouth — opens in proportion to lip separation
  const mouthOpen = _mouthOpenness(f.landmarks);
  const mh = r * 0.05 + mouthOpen * r * 0.35;
  const mw = r * 0.3;
  ctx.fillStyle = "#9a2c3a";
  ctx.strokeStyle = "#000";
  ctx.beginPath();
  ctx.ellipse(0, r * 0.4, mw, mh, 0, 0, 2 * Math.PI);
  ctx.fill();
  ctx.stroke();

  ctx.restore();
}

// Hook avatar into the face draw pass so it uses the fresh face data per frame.
const _origDrawFaceOn = _drawFaceOn;
_drawFaceOn = function patched(ctx, data) {
  if (avatarOn && data.faces?.length) {
    for (const f of data.faces) {
      _drawAvatar(ctx, f, ctx.canvas.width, ctx.canvas.height);
    }
    return;  // avatar replaces the mesh when on
  }
  _origDrawFaceOn(ctx, data);
};

avatarBtnEl.addEventListener("click", () => {
  avatarOn = !avatarOn;
  avatarBtnEl.setAttribute("aria-pressed", avatarOn ? "true" : "false");
  // Avatar depends on face mesh + head pose — auto-start FACE if user hasn't.
  if (avatarOn && !faceTimer && camStream) startFace();
  drawOverlay();
});

/* ---------- live SEGMENT-all loop (FastSAM auto, when TRACK is off) ---------- */
let segallTimer = null, segallToken = 0, segallBusy = false;

async function segallTick() {
  if (segallBusy || !camStream) return;
  const myToken = segallToken;
  segallBusy = true;
  try {
    const b = await captureFrame(RES.segment, 0.7);
    if (!b) return;
    const res = await fetch("/segment-all", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: b, imgsz: RES.segment }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (myToken !== segallToken) return;
    overlay.segall = data;
    drawOverlay();
    if (data.latency_ms != null) setStat("s-sam", `${data.latency_ms} ms`);
  } catch (err) {
    console.warn("segall loop", err);
    setStat("s-sam", "err");
  } finally {
    segallBusy = false;
  }
}

function startSegall() {
  if (segallTimer || !camStream) return;
  const t = ++segallToken;
  const loop = async () => {
    if (t !== segallToken) return;
    await segallTick();
    if (t === segallToken) segallTimer = setTimeout(loop, 30);
  };
  segallTimer = setTimeout(loop, 0);
}
function stopSegall() {
  segallToken++;
  if (segallTimer) clearTimeout(segallTimer);
  segallTimer = null;
  clearOverlayState("segall");
  drawOverlay();
}

/* Legacy one-shot FACE card (kept but no longer wired to the button). */
function _legacyFaceOneShot() {
  runOneShot("/face", "FACE", { emotion: true }, (data, origB64) => {
    const c = document.createElement("canvas");
    c.width = data.w; c.height = data.h;
    const ctx = c.getContext("2d");
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, data.w, data.h);
      ctx.fillStyle = "#39ff14";
      ctx.shadowColor = "#39ff14";
      ctx.shadowBlur = 4;
      for (const f of data.faces) {
        for (const [x, y] of f.landmarks) {
          ctx.beginPath();
          ctx.arc(x, y, 1.2, 0, 2*Math.PI);
          ctx.fill();
        }
      }
      ctx.shadowBlur = 0;
      // Emotion labels on each face box
      ctx.font = "16px 'Orbitron', 'Share Tech Mono', monospace";
      for (const f of data.faces) {
        if (!f.emotion) continue;
        const [x1, y1] = f.box;
        const label = `${f.emotion.toUpperCase()} ${(f.emotion_score*100|0)}%`;
        const tw = ctx.measureText(label).width + 10;
        ctx.fillStyle = "rgba(5,6,11,0.8)";
        ctx.fillRect(x1, Math.max(y1 - 22, 0), tw, 22);
        ctx.fillStyle = "#ff2bd6";
        ctx.shadowColor = "#ff2bd6";
        ctx.shadowBlur = 6;
        ctx.fillText(label, x1 + 5, Math.max(y1 - 6, 16));
        ctx.shadowBlur = 0;
      }
      const emos = data.faces.filter(f => f.emotion).map(f => f.emotion).join("/");
      const out = c.toDataURL("image/jpeg", 0.88).split(",")[1];
      _feedCard(`// FACE · ${data.faces.length} · ${emos || "no emotion"}`, "var(--green)", out);
    };
    img.src = `data:image/jpeg;base64,${origB64}`;
  });
}

/* Legacy one-shot POSE card. */
function _legacyPoseOneShot() {
  runOneShot("/pose", "POSE", {}, (data, origB64) => {
    // draw keypoints on a copy of the frame
    const c = document.createElement("canvas");
    c.width = data.w; c.height = data.h;
    const ctx = c.getContext("2d");
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, data.w, data.h);
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#ff2bd6";
      ctx.fillStyle = "#00f0ff";
      ctx.shadowColor = "#00f0ff";
      ctx.shadowBlur = 8;
      // COCO skeleton connections
      const skeleton = [[5,6],[5,11],[6,12],[11,12],[5,7],[7,9],[6,8],[8,10],[11,13],[13,15],[12,14],[14,16],[0,1],[0,2],[1,3],[2,4]];
      for (const p of data.people) {
        const kp = p.keypoints;
        const kc = p.kp_conf || [];
        for (const [a,b] of skeleton) {
          if ((kc[a] || 1) < 0.3 || (kc[b] || 1) < 0.3) continue;
          ctx.beginPath();
          ctx.moveTo(kp[a][0], kp[a][1]);
          ctx.lineTo(kp[b][0], kp[b][1]);
          ctx.stroke();
        }
        for (let i=0; i<kp.length; i++) {
          if ((kc[i] || 1) < 0.3) continue;
          ctx.beginPath();
          ctx.arc(kp[i][0], kp[i][1], 4, 0, 2*Math.PI);
          ctx.fill();
        }
      }
      ctx.shadowBlur = 0;
      const out = c.toDataURL("image/jpeg", 0.88).split(",")[1];
      _feedCard(`// POSE · ${data.people.length} people`, "var(--amber)", out);
    };
    img.src = `data:image/jpeg;base64,${origB64}`;
  });
}

const scanAutoBtn = document.getElementById("cam-scan-auto");
function startScanAuto() {
  if (scanTimer || !camStream) return;
  scanAutoBtn.setAttribute("aria-pressed", "true");
  const myToken = ++scanToken;
  const tick = async () => {
    if (myToken !== scanToken) return;
    await scanOnce();
    if (myToken === scanToken) {
      scanTimer = setTimeout(tick, parseInt(camInterval.value, 10) * 1000);
    }
  };
  scanTimer = setTimeout(tick, 0);
}
function stopScanAuto() {
  scanToken++;
  if (scanTimer) clearTimeout(scanTimer);
  scanTimer = null;
  scanAutoBtn.setAttribute("aria-pressed", "false");
}
scanAutoBtn.addEventListener("click", () => {
  if (scanTimer) stopScanAuto();
  else startScanAuto();
});

// ---------- cross-module surface ----------
// Register teardown hooks with camera so `stopCam()` tears us down.
registerPipelineStop(() => { if (typeof stopLive === "function") stopLive(); });
registerPipelineStop(() => { if (typeof stopTrack === "function") stopTrack(); });
registerPipelineStop(() => { if (typeof stopScanAuto === "function") stopScanAuto(); });
registerPipelineStop(() => { if (typeof stopPose === "function") stopPose(); });
registerPipelineStop(() => { if (typeof stopFace === "function") stopFace(); });
registerPipelineStop(() => { if (typeof stopPeople === "function") stopPeople(); });
registerPipelineStop(() => { if (typeof stopSegall === "function") stopSegall(); });
registerPipelineStop(() => { if (typeof stopBgSub === "function") stopBgSub(); });
registerPipelineStop(() => { if (typeof stopAnime === "function") stopAnime(); });
registerPipelineStop(() => { autoTrackPrimed = false; });

// Let camera.js call back into our overlay re-sync on window resize etc.
setSyncOverlayRect(syncOverlayRect);

// Public surface — ui.js's setMode calls these directly.
export { startLive, stopLive, startScanAuto, stopScanAuto };
