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
let thinkOn = localStorage.getItem("emma4.think") === "1";
function applyThink() {
  thinkEl.setAttribute("aria-pressed", thinkOn ? "true" : "false");
  const s = document.getElementById("s-think");
  if (s) s.textContent = thinkOn ? "ON" : "OFF";
}
thinkEl.addEventListener("click", () => {
  thinkOn = !thinkOn;
  localStorage.setItem("emma4.think", thinkOn ? "1" : "0");
  applyThink();
});
applyThink();

/* ---------- tool use ---------- */
const toolsEl = document.getElementById("tools-toggle");
let toolsOn = localStorage.getItem("emma4.tools") === "1";
function applyTools() {
  toolsEl.setAttribute("aria-pressed", toolsOn ? "true" : "false");
}
toolsEl.addEventListener("click", () => {
  toolsOn = !toolsOn;
  localStorage.setItem("emma4.tools", toolsOn ? "1" : "0");
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
  label.textContent = who === "user" ? "> USER" : who === "bot" ? "// EMMA" : "// SYS";
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
      $("s-model").textContent = s.model.name ?? "--";
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
const savedInterval = localStorage.getItem("emma4.interval");
if (savedInterval) {
  camInterval.value = savedInterval;
  camIntervalVal.textContent = `${savedInterval}s`;
}
camInterval.addEventListener("input", () => {
  camIntervalVal.textContent = `${camInterval.value}s`;
  localStorage.setItem("emma4.interval", camInterval.value);
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

let FRAME_SIZE = parseInt(localStorage.getItem("emma4.resolution") || "480", 10);
const selResolution = document.getElementById("select-resolution");
if (selResolution) {
  selResolution.value = String(FRAME_SIZE);
  selResolution.addEventListener("change", (e) => {
    FRAME_SIZE = parseInt(e.target.value, 10);
    localStorage.setItem("emma4.resolution", String(FRAME_SIZE));
    // Invalidate reusable capture canvas so it re-sizes to the new dims.
    _captureCanvas.canvas = null;
    _captureCanvas.cw = 0;
    _captureCanvas.ch = 0;
  });
}

function setStat(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
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
  "live-prompt", "live-prompt-reset", "emma4.livePrompt", DEFAULT_LIVE_PROMPT,
);
const scanPromptEl = bindPromptField(
  "scan-prompt", "scan-prompt-reset", "emma4.scanPrompt", DEFAULT_SCAN_PROMPT,
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
let masksOn = localStorage.getItem("emma4.masks") === "1";
masksToggle.setAttribute("aria-pressed", masksOn ? "true" : "false");
masksToggle.addEventListener("click", () => {
  masksOn = !masksOn;
  localStorage.setItem("emma4.masks", masksOn ? "1" : "0");
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

function drawDetections(result) {
  const { polygons, boxes, labels, confidences, w, h } = result;
  camCanvas.width = w;
  camCanvas.height = h;
  const ctx = camCanvas.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  camLabels.innerHTML = "";

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
    lbl.textContent = `${(labels[idx] || "?").toUpperCase()}${conf}`;
    camLabels.appendChild(lbl);
  }
}

async function trackOnce() {
  if (trackBusy || !camStream) return;
  const prompt = trackInput.value.trim();
  if (!prompt) return;
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
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
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
  clearOverlay();
}

trackToggle.addEventListener("click", () => {
  if (trackTimer) stopTrack();
  else startTrack();
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
  JSON.parse(localStorage.getItem("emma4.customTags") || "[]"),
);
function persistCustomTags() {
  localStorage.setItem("emma4.customTags", JSON.stringify([...customTags]));
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
    appendFeed(
      `[REPLACE] done · ${out.latency_ms} ms · ${out.width}×${out.height} · steps ${out.steps}`,
      "scan",
    );
  } catch (err) {
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
const savedStrength = localStorage.getItem("emma4.genStrength");
if (savedStrength) genStrength.value = savedStrength;
genStrengthVal.textContent = parseFloat(genStrength.value).toFixed(2);
genStrength.addEventListener("input", () => {
  genStrengthVal.textContent = parseFloat(genStrength.value).toFixed(2);
  localStorage.setItem("emma4.genStrength", genStrength.value);
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
    appendFeed(
      `[GEN] done · ${out.latency_ms} ms · ${out.width}×${out.height} · steps ${out.steps}`,
      "scan",
    );
  } catch (err) {
    appendFeed(`[GEN ERR] ${err.message}`, "err");
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
  localStorage.setItem("emma4.mode", m);
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
  emma: "emma4.model.emma",
  scan: "emma4.model.scan",
  detector: "emma4.model.detector",
  segmenter: "emma4.model.segmenter",
  inpaint: "emma4.model.inpaint",
  interval: "emma4.interval",
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
setMode(localStorage.getItem("emma4.mode") || "chat");
if (document.body.classList.contains("mode-chat")) inputEl.focus();
