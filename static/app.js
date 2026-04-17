const logEl = document.getElementById("log");
const formEl = document.getElementById("form");
const inputEl = document.getElementById("input");
const sendEl = document.getElementById("send");
const statusEl = document.querySelector(".status");
const statusText = document.getElementById("status-text");
const modelEl = document.getElementById("model-name");

const history = [];
const pending = { images: [] }; // base64 images queued for next send
const thinkEl = document.getElementById("think-toggle");
let thinkOn = localStorage.getItem("gemma4.think") === "1";
function applyThink() {
  thinkEl.setAttribute("aria-pressed", thinkOn ? "true" : "false");
  const s = document.getElementById("s-think");
  if (s) s.textContent = thinkOn ? "ON" : "OFF";
}
thinkEl.addEventListener("click", () => {
  thinkOn = !thinkOn;
  localStorage.setItem("gemma4.think", thinkOn ? "1" : "0");
  applyThink();
});
applyThink();

/* ---------- tool use ---------- */
const toolsEl = document.getElementById("tools-toggle");
let toolsOn = localStorage.getItem("gemma4.tools") === "1";
function applyTools() {
  toolsEl.setAttribute("aria-pressed", toolsOn ? "true" : "false");
}
toolsEl.addEventListener("click", () => {
  toolsOn = !toolsOn;
  localStorage.setItem("gemma4.tools", toolsOn ? "1" : "0");
  applyTools();
});
applyTools();

const SHELL_TOOL = {
  type: "function",
  function: {
    name: "run_shell",
    description:
      "Run a single shell command on the user's local macOS machine and return its stdout, stderr and exit code. " +
      "The user must approve every command before it executes. Useful for: listing/reading files (ls, cat, head, grep, find), " +
      "checking git state (git status, git log, git diff), inspecting system (ps, df, uname), fetching URLs (curl), " +
      "running language tools (python -c, node -e). Prefer read-only commands. Do not chain destructive operations.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to run. One line. Quote paths containing spaces.",
        },
      },
      required: ["command"],
    },
  },
};

const TOOL_IMPLS = {
  run_shell: (args) =>
    fetch("/tools/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: args.command, timeout: 60 }),
    }).then((r) => (r.ok ? r.json() : r.text().then((t) => Promise.reject(new Error(t))))),
};

function formatToolResult(res) {
  const body = (res.stdout || "") + (res.stderr ? `\n[stderr]\n${res.stderr}` : "");
  return body.trim() || `(no output, exit ${res.exit_code})`;
}

function approveCommand(toolCall, container) {
  return new Promise((resolve) => {
    const args = toolCall.function?.arguments || {};
    const initialCmd = String(args.command ?? "");
    const card = document.createElement("div");
    card.className = "tool-call";
    card.innerHTML = `
      <div class="tool-call-head">// TOOL · RUN_SHELL</div>
      <code class="tool-call-cmd" contenteditable="true" spellcheck="false"></code>
      <div class="tool-call-actions">
        <button type="button" class="approve-btn">APPROVE</button>
        <button type="button" class="deny-btn">DENY</button>
      </div>`;
    const cmdEl = card.querySelector(".tool-call-cmd");
    cmdEl.textContent = initialCmd;
    const approve = card.querySelector(".approve-btn");
    const deny = card.querySelector(".deny-btn");
    container.appendChild(card);
    scrollBottom();
    approve.addEventListener("click", () => {
      const finalCmd = cmdEl.textContent.trim();
      cmdEl.contentEditable = "false";
      approve.remove();
      deny.remove();
      resolve({ decision: "approve", command: finalCmd, card });
    });
    deny.addEventListener("click", () => {
      cmdEl.contentEditable = "false";
      approve.remove();
      deny.remove();
      resolve({ decision: "deny", command: initialCmd, card });
    });
  });
}

function renderToolResult(card, result, isError) {
  const pre = document.createElement("pre");
  pre.className = "tool-call-result" + (isError ? " err" : "");
  pre.textContent = result;
  card.appendChild(pre);
  scrollBottom();
}

function renderToolMeta(card, text) {
  const meta = document.createElement("div");
  meta.className = "tool-call-meta";
  meta.textContent = text;
  card.appendChild(meta);
}

function setStatus(state, text) {
  statusEl.classList.remove("busy", "err");
  if (state === "busy") statusEl.classList.add("busy");
  if (state === "err") statusEl.classList.add("err");
  statusText.textContent = text;
}

function scrollBottom() {
  logEl.scrollTop = logEl.scrollHeight;
}

function addMessage(who, text, opts = {}) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${who}`;
  const label = document.createElement("div");
  label.className = "who";
  label.textContent = who === "user" ? "> USER" : who === "bot" ? "// GEMMA" : "// SYS";
  const body = document.createElement("div");
  body.className = "body";
  if (opts.images && opts.images.length) {
    for (const b64 of opts.images) {
      const img = document.createElement("img");
      img.className = "inline-img";
      img.src = `data:image/jpeg;base64,${b64}`;
      body.appendChild(img);
    }
  }
  if (text) body.appendChild(document.createTextNode(text));
  if (opts.typing) body.classList.add("cursor");
  wrap.appendChild(label);
  wrap.appendChild(body);
  logEl.appendChild(wrap);
  scrollBottom();
  return body;
}

function autosize() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + "px";
}

inputEl.addEventListener("input", autosize);
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    formEl.requestSubmit();
  }
});

async function loadHealth() {
  try {
    const res = await fetch("/health");
    const data = await res.json();
    modelEl.textContent = data.default_model ?? "--";
    setStatus("ok", "LINK // READY");
  } catch {
    setStatus("err", "LINK // OFFLINE");
  }
}

const $ = (id) => document.getElementById(id);

function setBar(id, pct) {
  const el = $(id);
  if (el) el.style.width = `${Math.min(100, Math.max(0, pct)).toFixed(0)}%`;
}

async function pollStats() {
  try {
    const res = await fetch("/stats");
    if (!res.ok) return;
    const s = await res.json();
    if (s.model) {
      // Short display name — MLX ids have an `mlx:` prefix that crowds the tile.
      const rawName = s.model.name ?? "--";
      $("s-model").textContent = rawName.replace(/^mlx:/, "").slice(0, 28);
      $("s-backend").textContent = (s.model.backend ?? "--").toUpperCase();
      $("s-params").textContent = s.model.parameter_size ?? "--";
      $("s-quant").textContent = s.model.quantization ?? "--";
    }
    if (s.ollama) {
      $("s-rss").textContent = `${(s.ollama.rss_mb / 1024).toFixed(2)} GB`;
    } else {
      $("s-rss").textContent = "--";
    }
    if (s.system) {
      const cpu = s.system.cpu_percent ?? 0;
      $("s-cpu").textContent = `${cpu.toFixed(0)}%`;
      setBar("s-cpu-bar", cpu);
      const mem = s.system.memory_percent ?? 0;
      $("s-mem").textContent = `${s.system.memory_used_gb}/${s.system.memory_total_gb}G`;
      setBar("s-mem-bar", mem);
    }
  } catch {
    /* ignore */
  }
}
setInterval(pollStats, 2000);
pollStats();

// Cap generation per turn so a misbehaving model can't churn indefinitely.
const CHAT_MAX_TOKENS = 800;
// Keep history bounded: system/user pairs beyond this are dropped oldest-first.
const HISTORY_MAX_MESSAGES = 40;

function trimHistoryInPlace() {
  if (history.length <= HISTORY_MAX_MESSAGES) return;
  const excess = history.length - HISTORY_MAX_MESSAGES;
  history.splice(0, excess);
}

async function streamChatTurn(botBody) {
  trimHistoryInPlace();
  const payload = {
    messages: history,
    stream: true,
    think: thinkOn,
    max_tokens: CHAT_MAX_TOKENS,
  };
  if (toolsOn) payload.tools = [SHELL_TOOL];
  const res = await fetch("/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";
  let thought = "";
  let thoughtEl = null;
  let thoughtBodyEl = null;
  let finalEvt = null;
  const toolCalls = [];
  const startedAt = performance.now();
  let firstTokenAt = null;

  const ensureThought = () => {
    if (thoughtEl) return;
    thoughtEl = document.createElement("details");
    thoughtEl.className = "thought";
    thoughtEl.open = true;
    const sum = document.createElement("summary");
    sum.textContent = "REASONING";
    thoughtBodyEl = document.createElement("div");
    thoughtBodyEl.className = "thought-body";
    thoughtEl.appendChild(sum);
    thoughtEl.appendChild(thoughtBodyEl);
    botBody.parentElement.insertBefore(thoughtEl, botBody);
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const evt = JSON.parse(line);
        if (evt.error) throw new Error(evt.error);
        const thinkDelta = evt.message?.thinking ?? "";
        if (thinkDelta) {
          if (firstTokenAt === null) firstTokenAt = performance.now();
          thought += thinkDelta;
          ensureThought();
          thoughtBodyEl.textContent = thought;
          scrollBottom();
        }
        const delta = evt.message?.content ?? "";
        if (delta) {
          if (firstTokenAt === null) firstTokenAt = performance.now();
          full += delta;
          botBody.textContent = full;
          scrollBottom();
        }
        if (evt.message?.tool_calls) {
          for (const tc of evt.message.tool_calls) toolCalls.push(tc);
        }
        if (evt.done) finalEvt = evt;
      } catch {
        /* partial json */
      }
    }
  }
  if (thoughtEl) thoughtEl.open = false;
  return { content: full, toolCalls, finalEvt, botBody, startedAt, firstTokenAt };
}

function renderTurnMeta(botBody, turn) {
  if (!turn.finalEvt) return;
  const tokens = turn.finalEvt.eval_count ?? 0;
  const evalSec = (turn.finalEvt.eval_duration ?? 0) / 1e9;
  const tps = evalSec > 0 ? (tokens / evalSec).toFixed(1) : "--";
  const ttft = turn.firstTokenAt ? ((turn.firstTokenAt - turn.startedAt) / 1000).toFixed(2) : "--";
  const totalS = ((performance.now() - turn.startedAt) / 1000).toFixed(2);
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.innerHTML = `<b>${tps} tok/s</b> · ${tokens} tokens · TTFT ${ttft}s · total ${totalS}s`;
  // Inline SPEAK button so the user can hear the answer via Kokoro TTS.
  const speakBtn = document.createElement("button");
  speakBtn.type = "button";
  speakBtn.className = "speak-btn";
  speakBtn.textContent = "♪ SPEAK";
  speakBtn.addEventListener("click", () => {
    const text = botBody.textContent || "";
    if (text) speakText(text, speakBtn);
  });
  meta.appendChild(speakBtn);
  botBody.parentElement.appendChild(meta);
  const last = document.getElementById("s-last");
  if (last) last.textContent = `${tps} tok/s`;
}

async function send(text) {
  const imgs = pending.images.splice(0);
  renderAttachStrip();
  const effectiveText = text || (imgs.length ? "Describe what you see." : "");
  const userMsg = { role: "user", content: effectiveText };
  if (imgs.length) userMsg.images = imgs;
  history.push(userMsg);
  addMessage("user", text, { images: imgs });

  setStatus("busy", "LINK // STREAMING");
  sendEl.disabled = true;

  try {
    const MAX_TOOL_ROUNDS = 6;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const botBody = addMessage("bot", "", { typing: true });
      let turn;
      try {
        turn = await streamChatTurn(botBody);
      } catch (err) {
        botBody.classList.remove("cursor");
        botBody.textContent = `[ERR] ${err.message}`;
        setStatus("err", "LINK // ERROR");
        return;
      }
      botBody.classList.remove("cursor");

      // Push the assistant message (with any tool calls) into history so the
      // next turn references it correctly.
      const asstMsg = { role: "assistant", content: turn.content };
      if (turn.toolCalls.length) asstMsg.tool_calls = turn.toolCalls;
      history.push(asstMsg);
      renderTurnMeta(botBody, turn);

      if (!turn.toolCalls.length) {
        setStatus("ok", "LINK // READY");
        return;
      }

      // One approval card per requested tool call, executed sequentially.
      for (const tc of turn.toolCalls) {
        const fn = tc.function?.name;
        if (fn !== "run_shell") {
          history.push({ role: "tool", content: `[unknown tool ${fn}]`, tool_name: fn });
          continue;
        }
        setStatus("busy", "LINK // AWAITING APPROVAL");
        const decision = await approveCommand(tc, botBody.parentElement);
        if (decision.decision === "deny") {
          renderToolMeta(decision.card, "denied by user");
          history.push({
            role: "tool",
            content: "[user denied execution]",
            tool_name: "run_shell",
          });
          continue;
        }
        setStatus("busy", "LINK // EXECUTING");
        try {
          const t0 = performance.now();
          const result = await TOOL_IMPLS.run_shell({ command: decision.command });
          const out = formatToolResult(result);
          renderToolResult(decision.card, out, result.exit_code !== 0);
          renderToolMeta(
            decision.card,
            `exit ${result.exit_code} · ${Math.round(performance.now() - t0)} ms${result.truncated ? " · truncated" : ""}`,
          );
          history.push({
            role: "tool",
            content:
              `$ ${decision.command}\n` +
              `[exit ${result.exit_code}]\n` +
              out,
            tool_name: "run_shell",
          });
        } catch (err) {
          renderToolResult(decision.card, `[ERR] ${err.message}`, true);
          history.push({
            role: "tool",
            content: `[exec failed] ${err.message}`,
            tool_name: "run_shell",
          });
        }
      }
      setStatus("busy", "LINK // STREAMING");
      // Loop: re-stream with the tool results so Gemma can produce a final reply.
    }
  } finally {
    sendEl.disabled = false;
    inputEl.focus();
  }
}

formEl.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = inputEl.value.trim();
  if (!text && pending.images.length === 0) return;
  inputEl.value = "";
  autosize();
  send(text);
});

/* ---------- attach / paste / resize ---------- */
const attachInput = document.getElementById("attach-input");
const attachBtn = document.getElementById("attach-btn");
const attachStrip = document.getElementById("attach-strip");

function renderAttachStrip() {
  attachStrip.innerHTML = "";
  if (!pending.images.length) {
    attachStrip.hidden = true;
    return;
  }
  attachStrip.hidden = false;
  pending.images.forEach((b64, i) => {
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.innerHTML = `<img src="data:image/jpeg;base64,${b64}"/><span class="x">×</span>`;
    chip.querySelector(".x").addEventListener("click", () => {
      pending.images.splice(i, 1);
      renderAttachStrip();
    });
    attachStrip.appendChild(chip);
  });
}

function _bytesToBase64(bytes) {
  // Chunked charCode concat avoids pathological O(n^2) string growth.
  const CHUNK = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function fileToResizedB64(file, max = FRAME_SIZE, quality = 0.82) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bmp, 0, 0, w, h);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
  const buf = await blob.arrayBuffer();
  return _bytesToBase64(new Uint8Array(buf));
}

attachBtn.addEventListener("click", () => attachInput.click());
attachInput.addEventListener("change", async (e) => {
  for (const f of e.target.files) {
    if (!f.type.startsWith("image/")) continue;
    pending.images.push(await fileToResizedB64(f));
  }
  attachInput.value = "";
  renderAttachStrip();
});

/* ---------- Mic button (hold to record → Whisper transcribe) ---------- */
const micBtn = document.getElementById("mic-btn");
let mediaRecorder = null;
let recordedChunks = [];
let recordStream = null;

async function startRecording() {
  try {
    recordStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = [];
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/mp4")
        ? "audio/mp4"
        : "";
    mediaRecorder = new MediaRecorder(recordStream, mime ? { mimeType: mime } : {});
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };
    mediaRecorder.onstop = async () => {
      recordStream.getTracks().forEach((t) => t.stop());
      recordStream = null;
      const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType });
      const buf = await blob.arrayBuffer();
      const b64 = _bytesToBase64(new Uint8Array(buf));
      micBtn.classList.remove("recording");
      micBtn.textContent = "⋯";
      try {
        const res = await fetch("/transcribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ audio: b64 }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.latency_ms != null) setStat("s-op-stt", `${data.latency_ms} ms`);
        if (data.text) {
          inputEl.value = (inputEl.value ? inputEl.value + " " : "") + data.text;
          autosize();
          inputEl.focus();
        }
      } catch (err) {
        if (document.body.classList.contains("mode-video")) {
          appendFeed(`[STT ERR] ${err.message}`, "err");
        } else {
          addMessage("sys", `[STT ERR] ${err.message}`);
        }
      } finally {
        micBtn.textContent = "🎤";
      }
    };
    mediaRecorder.start();
    micBtn.classList.add("recording");
    micBtn.textContent = "●";
  } catch (err) {
    alert(`mic failed: ${err.message}`);
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
    mediaRecorder = null;
  }
}

micBtn.addEventListener("mousedown", startRecording);
micBtn.addEventListener("touchstart", startRecording, { passive: true });
micBtn.addEventListener("mouseup", stopRecording);
micBtn.addEventListener("mouseleave", stopRecording);
micBtn.addEventListener("touchend", stopRecording);

/* ---------- Speak button on bot messages (Kokoro TTS) ---------- */
let _speakAudio = null;
let _speakBtn = null;

async function speakText(text, btn) {
  if (_speakAudio) {
    _speakAudio.pause();
    _speakAudio = null;
    if (_speakBtn) _speakBtn.classList.remove("playing");
  }
  btn.classList.add("playing");
  btn.textContent = "⏹ STOP";
  _speakBtn = btn;
  try {
    const res = await fetch("/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text.slice(0, 900) }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.latency_ms != null) setStat("s-op-tts", `${data.latency_ms} ms`);
    _speakAudio = new Audio(`data:audio/wav;base64,${data.audio}`);
    _speakAudio.onended = () => {
      btn.classList.remove("playing");
      btn.textContent = "♪ SPEAK";
      _speakAudio = null;
    };
    _speakAudio.play();
  } catch (err) {
    btn.classList.remove("playing");
    btn.textContent = "♪ SPEAK";
    setStat("s-op-tts", "err");
    console.warn("TTS failed:", err);
  }
}

inputEl.addEventListener("paste", async (e) => {
  const items = e.clipboardData?.items || [];
  for (const it of items) {
    if (it.type.startsWith("image/")) {
      e.preventDefault();
      pending.images.push(await fileToResizedB64(it.getAsFile()));
      renderAttachStrip();
    }
  }
});

/* ---------- webcam ---------- */
const camVideo = document.getElementById("cam-video");
const camLive = document.getElementById("cam-live");
const camInterval = document.getElementById("cam-interval");
const camIntervalVal = document.getElementById("cam-interval-val");
const camFeedBody = document.getElementById("cam-feed-body");

let camStream = null;
let camResizeObserver = null;
let liveTimer = null;
let liveBusy = false;
let liveToken = 0;
let trackToken = 0;
let scanTimer = null;
let scanBusy = false;
let scanToken = 0;

// Restore saved interval
const savedInterval = localStorage.getItem("gemma4.interval");
if (savedInterval) {
  camInterval.value = savedInterval;
  camIntervalVal.textContent = `${savedInterval}s`;
}
camInterval.addEventListener("input", () => {
  camIntervalVal.textContent = `${camInterval.value}s`;
  localStorage.setItem("gemma4.interval", camInterval.value);
  if (liveTimer) restartLive();
});

async function startCam() {
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
      if (w && h) {
        camVideo.parentElement.style.aspectRatio = `${w} / ${h}`;
      }
      syncOverlayRect();
    };
    if (camVideo.videoWidth) syncAspect();
    camVideo.addEventListener("loadedmetadata", syncAspect, { once: true });
    camVideo.addEventListener("resize", syncAspect);
    if (!camResizeObserver) {
      camResizeObserver = new ResizeObserver(syncOverlayRect);
      camResizeObserver.observe(camVideo);
      window.addEventListener("resize", syncOverlayRect);
    }
  } catch (err) {
    appendFeed(`[CAM] failed: ${err.message}`, "err");
  }
}

function stopCam() {
  stopLive();
  if (typeof stopTrack === "function") stopTrack();
  if (typeof stopScanAuto === "function") stopScanAuto();
  if (typeof stopPose === "function") stopPose();
  if (typeof stopFace === "function") stopFace();
  if (typeof stopPeople === "function") stopPeople();
  autoTrackPrimed = false;
  if (camResizeObserver) {
    camResizeObserver.disconnect();
    camResizeObserver = null;
    window.removeEventListener("resize", syncOverlayRect);
  }
  if (camStream) {
    camStream.getTracks().forEach((t) => t.stop());
    camStream = null;
  }
  camVideo.srcObject = null;
}

let FRAME_SIZE = parseInt(localStorage.getItem("gemma4.resolution") || "480", 10);
const selResolution = document.getElementById("select-resolution");
if (selResolution) {
  selResolution.value = String(FRAME_SIZE);
  selResolution.addEventListener("change", (e) => {
    FRAME_SIZE = parseInt(e.target.value, 10);
    localStorage.setItem("gemma4.resolution", String(FRAME_SIZE));
    // Invalidate reusable capture canvas so it re-sizes to the new dims.
    _captureCanvas.canvas = null;
    _captureCanvas.cw = 0;
    _captureCanvas.ch = 0;
  });
}

function setStat(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
  // Recompute the PIPELINE LATENCY total whenever a contributing tile updates.
  if (["s-live", "s-scan", "s-yolo", "s-sam"].includes(id)) recomputeTotal();
}

function parseMs(txt) {
  if (!txt) return null;
  const m = String(txt).match(/(\d+(?:\.\d+)?)\s*ms/);
  return m ? parseFloat(m[1]) : null;
}

function recomputeTotal() {
  const ids = ["s-live", "s-scan", "s-yolo", "s-sam"];
  let sum = 0;
  let any = false;
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    const v = parseMs(el.textContent);
    if (v != null) {
      sum += v;
      any = true;
    }
  }
  const t = document.getElementById("s-total");
  if (t) t.textContent = any ? `${Math.round(sum)} ms` : "--";
}

const _captureCanvas = { canvas: null, cw: 0, ch: 0 };
async function captureFrame(max = FRAME_SIZE, quality = 0.7) {
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
  return _bytesToBase64(new Uint8Array(buf));
}

function appendFeed(text, kind = "info") {
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

function clearFeed() {
  camFeedBody.innerHTML = "";
}

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
  "live-prompt", "live-prompt-reset", "gemma4.livePrompt", DEFAULT_LIVE_PROMPT,
);
const scanPromptEl = bindPromptField(
  "scan-prompt", "scan-prompt-reset", "gemma4.scanPrompt", DEFAULT_SCAN_PROMPT,
);

async function liveDescribe() {
  if (liveBusy || !camStream) return;
  liveBusy = true;
  const t0 = performance.now();
  try {
    const b = await captureFrame(FRAME_SIZE, 0.65);
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
const camCanvas = document.getElementById("cam-canvas");
const camLabels = document.getElementById("cam-labels");
let trackTimer = null;
let trackBusy = false;
let masksOn = localStorage.getItem("gemma4.masks") === "1";
masksToggle.setAttribute("aria-pressed", masksOn ? "true" : "false");
masksToggle.addEventListener("click", () => {
  masksOn = !masksOn;
  localStorage.setItem("gemma4.masks", masksOn ? "1" : "0");
  masksToggle.setAttribute("aria-pressed", masksOn ? "true" : "false");
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
const overlay = { detect: null, pose: null, face: null, people: null };
function clearOverlayState(which) {
  if (which) overlay[which] = null;
  else { overlay.detect = null; overlay.pose = null; overlay.face = null; overlay.people = null; }
}

function drawOverlay() {
  const srcs = [overlay.detect, overlay.pose, overlay.face, overlay.people].filter(Boolean);
  if (!srcs.length) { clearOverlay(); return; }
  const cw = Math.max(...srcs.map((s) => s.w || 0));
  const ch = Math.max(...srcs.map((s) => s.h || 0));
  camCanvas.width = cw;
  camCanvas.height = ch;
  const ctx = camCanvas.getContext("2d");
  ctx.clearRect(0, 0, cw, ch);
  camLabels.innerHTML = "";
  // Draw people mat first so detections/skeleton/face sit on top.
  if (overlay.people) _drawPeopleOn(ctx, overlay.people);
  if (overlay.detect) _drawDetectionsOn(ctx, overlay.detect, cw, ch);
  if (overlay.pose)   _drawPoseOn(ctx, overlay.pose);
  if (overlay.face)   _drawFaceOn(ctx, overlay.face);
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
    if (!parts.length) continue;
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
    const b = await captureFrame(FRAME_SIZE, 0.7);
    if (!b) return;
    const res = await fetch("/detect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: b,
        prompt,
        masks: masksOn,
        imgsz: FRAME_SIZE,
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
}

trackToggle.addEventListener("click", () => {
  if (trackTimer || document.body.classList.contains("track-armed")) {
    stopTrack();
    return;
  }
  // Arm the section so the user can edit the track input / chips before the
  // loop actually starts. If there's already text, start immediately.
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
  JSON.parse(localStorage.getItem("gemma4.customTags") || "[]"),
);
function persistCustomTags() {
  localStorage.setItem("gemma4.customTags", JSON.stringify([...customTags]));
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
  if (selected.size && !trackTimer && camStream) startTrack();
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
  scanBtn.textContent = "SCANNING…";
  try {
    const b = await captureFrame(FRAME_SIZE, 0.8);
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
    scanBtn.textContent = "SCAN";
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
const savedStrength = localStorage.getItem("gemma4.genStrength");
if (savedStrength) genStrength.value = savedStrength;
genStrengthVal.textContent = parseFloat(genStrength.value).toFixed(2);
genStrength.addEventListener("input", () => {
  genStrengthVal.textContent = parseFloat(genStrength.value).toFixed(2);
  localStorage.setItem("gemma4.genStrength", genStrength.value);
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
    const b = await captureFrame(FRAME_SIZE, 0.75);
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
    const b = await captureFrame(FRAME_SIZE, 0.75);
    if (!b) return;
    const res = await fetch("/face", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: b, emotion: true }),
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
    const b = await captureFrame(FRAME_SIZE, 0.75);
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

/* ---------- mode switcher (CHAT / VIDEO) ---------- */
async function setMode(mode) {
  const m = mode === "video" ? "video" : "chat";
  document.body.classList.remove("mode-chat", "mode-video");
  document.body.classList.add(`mode-${m}`);
  document.querySelectorAll(".mode-btn").forEach((b) => {
    b.setAttribute("aria-pressed", b.dataset.mode === m ? "true" : "false");
  });
  localStorage.setItem("gemma4.mode", m);
  if (m === "video") {
    await startCam();
    if (!camStream) return;
    // Wait one tick for videoWidth/height to land before downstream captures.
    if (!camVideo.videoWidth) {
      await new Promise((r) => camVideo.addEventListener("loadedmetadata", r, { once: true }));
    }
    startLive();
    startScanAuto();
    // TRACK auto-starts inside renderChips once the first scan returns chips.
  } else {
    stopCam();
  }
}
document.querySelectorAll(".mode-btn").forEach((btn) => {
  btn.addEventListener("click", () => setMode(btn.dataset.mode));
});

function clearCurrent() {
  if (document.body.classList.contains("mode-video")) {
    clearFeed();
    return;
  }
  history.length = 0;
  pending.images.length = 0;
  renderAttachStrip();
  logEl.innerHTML = "";
  addMessage("sys", "Neural link purged. Memory wiped. Ready for new transmission.");
  const last = document.getElementById("s-last");
  if (last) last.textContent = "--";
  inputEl.focus();
}

document.getElementById("clear").addEventListener("click", clearCurrent);

/* ---------- model dropdowns (EMMA / SCAN / YOLO) + PULL ---------- */
const selEmma = document.getElementById("select-emma");
const selScan = document.getElementById("select-scan");
const selDetector = document.getElementById("select-detector");
const selSegmenter = document.getElementById("select-segmenter");
const selInpaint = document.getElementById("select-inpaint");

function fillOllamaSelect(sel, models, current) {
  sel.innerHTML = "";
  if (!models.length) {
    const o = document.createElement("option");
    o.textContent = "(none installed)";
    o.disabled = true;
    sel.appendChild(o);
    return;
  }
  for (const m of models) {
    const o = document.createElement("option");
    o.value = m.name;
    const params = m.parameter_size || "?";
    const sz = m.size_gb != null ? `${m.size_gb}G` : "";
    o.textContent = `${m.name} · ${params} · ${sz}`;
    if (m.name === current) o.selected = true;
    sel.appendChild(o);
  }
}

const STORAGE = {
  emma: "gemma4.model.emma",
  scan: "gemma4.model.scan",
  detector: "gemma4.model.detector",
  segmenter: "gemma4.model.segmenter",
  inpaint: "gemma4.model.inpaint",
  interval: "gemma4.interval",
};

function fillPresetSelect(sel, presets, current) {
  sel.innerHTML = "";
  for (const p of presets) {
    const o = document.createElement("option");
    o.value = p.name;
    o.textContent = p.label || p.name;
    if (p.name === current) o.selected = true;
    sel.appendChild(o);
  }
}

async function postModelChange(path, name, sel, storageKey) {
  sel.disabled = true;
  console.log(`[model] ${path} -> ${name}`);
  if (document.body.classList.contains("mode-video")) {
    appendFeed(`[MODEL] ${path.split("/").pop()} → ${name}`, "scan");
  }
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(err);
    }
    if (storageKey) localStorage.setItem(storageKey, name);
    setStatus("ok", `SWITCHED // ${name.toUpperCase().slice(0, 24)}`);
  } catch (err) {
    setStatus("err", `SWITCH FAIL`);
    console.warn(`[model] ${path} failed:`, err);
    if (document.body.classList.contains("mode-video")) {
      appendFeed(`[MODEL ERR] ${err.message}`, "err");
    } else {
      addMessage("sys", `[MODEL ERR ${path}] ${err.message}`);
    }
  } finally {
    sel.disabled = false;
    setTimeout(() => setStatus("ok", "LINK // READY"), 1200);
  }
}

async function refreshModels() {
  try {
    const res = await fetch("/models");
    if (!res.ok) return;
    const d = await res.json();
    fillOllamaSelect(selEmma, d.emma.available, d.emma.current);
    fillOllamaSelect(selScan, d.scan.available, d.scan.current);
    fillPresetSelect(selDetector, d.detector.presets, d.detector.current);
    fillPresetSelect(selSegmenter, d.segmenter.presets, d.segmenter.current);
    if (d.inpaint) fillPresetSelect(selInpaint, d.inpaint.presets, d.inpaint.current);

    const maybeRestore = async (key, currentValue, available, url, sel, isPreset) => {
      const saved = localStorage.getItem(key);
      if (!saved || saved === currentValue) return;
      const match = isPreset
        ? available.some((m) => m.name === saved)
        : available.some((m) => m.name === saved);
      if (!match) return;
      sel.value = saved;
      await postModelChange(url, saved, sel, key);
    };
    await maybeRestore(STORAGE.emma, d.emma.current, d.emma.available, "/models/emma", selEmma, false);
    await maybeRestore(STORAGE.scan, d.scan.current, d.scan.available, "/models/scan", selScan, false);
    await maybeRestore(STORAGE.detector, d.detector.current, d.detector.presets, "/models/detector", selDetector, true);
    await maybeRestore(STORAGE.segmenter, d.segmenter.current, d.segmenter.presets, "/models/segmenter", selSegmenter, true);
    if (d.inpaint) {
      await maybeRestore(STORAGE.inpaint, d.inpaint.current, d.inpaint.presets, "/models/inpaint", selInpaint, true);
    }
  } catch {
    /* ignore */
  }
}

selEmma.addEventListener("change", (e) =>
  postModelChange("/models/emma", e.target.value, selEmma, STORAGE.emma),
);
selScan.addEventListener("change", (e) =>
  postModelChange("/models/scan", e.target.value, selScan, STORAGE.scan),
);
selDetector.addEventListener("change", (e) =>
  postModelChange("/models/detector", e.target.value, selDetector, STORAGE.detector),
);
selSegmenter.addEventListener("change", (e) =>
  postModelChange("/models/segmenter", e.target.value, selSegmenter, STORAGE.segmenter),
);
selInpaint.addEventListener("change", (e) =>
  postModelChange("/models/inpaint", e.target.value, selInpaint, STORAGE.inpaint),
);

addMessage("sys", "Neural link established. Gemma-4 online. Transmit query below.");
loadHealth();
refreshModels();
setMode(localStorage.getItem("gemma4.mode") || "chat");
if (document.body.classList.contains("mode-chat")) inputEl.focus();
