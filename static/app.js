const logEl = document.getElementById("log");
const formEl = document.getElementById("form");
const inputEl = document.getElementById("input");
const sendEl = document.getElementById("send");
const statusEl = document.querySelector(".status");
const statusText = document.getElementById("status-text");
const modelEl = document.getElementById("model-name");

const history = [];
const pending = { images: [] }; // base64 images queued for next send

/* ---------- theme cycling ---------- */
const THEMES = ["cyberpunk", "light", "dark", "ice", "matrix"];
const THEME_LABEL = { cyberpunk: "◐", light: "☀", dark: "☾", ice: "❄", matrix: "▣" };
function applyTheme(name) {
  if (!THEMES.includes(name)) name = "cyberpunk";
  const root = document.documentElement;
  for (const t of THEMES) if (t !== "cyberpunk") root.classList.remove("theme-" + t);
  if (name !== "cyberpunk") root.classList.add("theme-" + name);
  const btn = document.getElementById("theme-btn");
  if (btn) {
    btn.textContent = THEME_LABEL[name] || "◐";
    btn.title = `Theme: ${name} (click to cycle)`;
  }
  console.info("[theme] applied", name);
}
function cycleTheme() {
  const cur = localStorage.getItem("chatlm.theme") || "cyberpunk";
  const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
  localStorage.setItem("chatlm.theme", next);
  applyTheme(next);
}
applyTheme(localStorage.getItem("chatlm.theme") || "cyberpunk");
// Delegated click so it works even if wiring runs before the button mounts
// or if some other listener swallows the event on the button itself.
document.addEventListener("click", (e) => {
  if (e.target && e.target.closest && e.target.closest("#theme-btn")) cycleTheme();
});

const thinkEl = document.getElementById("think-toggle");
let thinkOn = localStorage.getItem("chatlm.think") === "1";
function applyThink() {
  thinkEl.setAttribute("aria-pressed", thinkOn ? "true" : "false");
  const s = document.getElementById("s-think");
  if (s) s.textContent = thinkOn ? "ON" : "OFF";
}
thinkEl.addEventListener("click", () => {
  thinkOn = !thinkOn;
  localStorage.setItem("chatlm.think", thinkOn ? "1" : "0");
  applyThink();
});
applyThink();

/* ---------- tool use ---------- */
const toolsEl = document.getElementById("tools-toggle");
let toolsOn = localStorage.getItem("chatlm.tools") === "1";
const autoApproveEl = document.getElementById("auto-approve");
const autoApproveWrap = document.getElementById("auto-approve-wrap");
let autoApproveOn = localStorage.getItem("chatlm.autoApprove") === "1";

function applyTools() {
  toolsEl.setAttribute("aria-pressed", toolsOn ? "true" : "false");
  // Toggle body class so the AUTO-APPROVE checkbox only renders when tools
  // are enabled (it has no effect otherwise).
  document.body.classList.toggle("tools-on", toolsOn);
  // When tools get switched off, also disarm auto-approve so re-enabling
  // tools later starts safe (avoids surprise auto-execution).
  if (!toolsOn && autoApproveOn) {
    autoApproveOn = false;
    localStorage.setItem("chatlm.autoApprove", "0");
    autoApproveEl.checked = false;
    autoApproveWrap.classList.remove("armed");
  }
}
toolsEl.addEventListener("click", () => {
  toolsOn = !toolsOn;
  localStorage.setItem("chatlm.tools", toolsOn ? "1" : "0");
  applyTools();
});
autoApproveEl.checked = autoApproveOn;
autoApproveWrap.classList.toggle("armed", autoApproveOn);
autoApproveEl.addEventListener("change", () => {
  autoApproveOn = autoApproveEl.checked;
  localStorage.setItem("chatlm.autoApprove", autoApproveOn ? "1" : "0");
  autoApproveWrap.classList.toggle("armed", autoApproveOn);
});
applyTools();

const SHELL_TOOL = {
  type: "function",
  function: {
    name: "run_shell",
    description:
      "Execute a single shell command on the user's local macOS machine and receive stdout, stderr, exit code. " +
      "The user owns this machine and sees an APPROVE/DENY card for every command before it runs — consent is built in. " +
      "USE THIS WHENEVER the user asks about local files/folders/processes/git/system info. " +
      "Examples that REQUIRE this tool, not a refusal: " +
      "'look in my Downloads folder' → ls -la ~/Downloads ; " +
      "'what's in this dir' → ls ; " +
      "'show recent commits' → git log --oneline -10 ; " +
      "'check disk space' → df -h ; " +
      "'find pdfs from last week' → find ~/Documents -name '*.pdf' -mtime -7 . " +
      "Do NOT say 'I cannot access your filesystem' — you can, via this tool. Do NOT ask the user to run it themselves. " +
      "Prefer read-only commands; never chain destructive ops without explaining first.",
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

const IMAGE_TOOL = {
  type: "function",
  function: {
    name: "generate_image",
    description:
      "Generate a brand-new image from a text prompt using a local diffusion model " +
      "(Stable Diffusion XL / FLUX.1-schnell / SD 3.5). Use this when the user asks " +
      "you to 'create', 'make', 'draw', 'render', or 'generate' a picture/photo/illustration. " +
      "The user must approve before generation runs (~5-30s wall time).",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Rich description of the image to create. Include subject, style, mood, composition.",
        },
        negative_prompt: {
          type: "string",
          description: "Optional: things to avoid in the image (ignored for FLUX).",
        },
      },
      required: ["prompt"],
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
  // `generate_image` deliberately lives in handleGenerateImage() — it
  // needs progress streaming, the approve card, session binding. Keep
  // TOOL_IMPLS for tools whose UI is "just fire and render the result".
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
    const headLabel = autoApproveOn ? "// TOOL · RUN_SHELL · AUTO" : "// TOOL · RUN_SHELL";
    card.innerHTML = `
      <div class="tool-call-head">${headLabel}</div>
      <code class="tool-call-cmd" contenteditable="${autoApproveOn ? "false" : "true"}" spellcheck="false"></code>
      <div class="tool-call-actions"></div>`;
    const cmdEl = card.querySelector(".tool-call-cmd");
    cmdEl.textContent = initialCmd;
    container.appendChild(card);
    scrollBottom();
    if (autoApproveOn) {
      // Resolve on next tick so the card paints before execution starts.
      setTimeout(() => resolve({ decision: "approve", command: initialCmd, card }), 0);
      return;
    }
    const actions = card.querySelector(".tool-call-actions");
    actions.innerHTML = `
      <button type="button" class="approve-btn">APPROVE</button>
      <button type="button" class="deny-btn">DENY</button>`;
    const approve = actions.querySelector(".approve-btn");
    const deny = actions.querySelector(".deny-btn");
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

function approveImagePrompt(args, container) {
  return new Promise((resolve) => {
    const initialPrompt = String(args.prompt ?? "");
    const card = document.createElement("div");
    card.className = "tool-call tool-call-image";
    const headLabel = autoApproveOn ? "// TOOL · GENERATE_IMAGE · AUTO" : "// TOOL · GENERATE_IMAGE";
    card.innerHTML = `
      <div class="tool-call-head">${headLabel}</div>
      <div class="tool-call-cmd" contenteditable="${autoApproveOn ? "false" : "true"}" spellcheck="false"></div>
      <div class="tool-call-actions"></div>`;
    const promptEl = card.querySelector(".tool-call-cmd");
    promptEl.textContent = initialPrompt;
    container.appendChild(card);
    scrollBottom();
    if (autoApproveOn) {
      setTimeout(() => resolve({ decision: "approve", prompt: initialPrompt, card }), 0);
      return;
    }
    const actions = card.querySelector(".tool-call-actions");
    actions.innerHTML = `
      <button type="button" class="approve-btn">PAINT</button>
      <button type="button" class="deny-btn">DENY</button>`;
    const approve = actions.querySelector(".approve-btn");
    const deny = actions.querySelector(".deny-btn");
    approve.addEventListener("click", () => {
      const finalPrompt = promptEl.textContent.trim();
      promptEl.contentEditable = "false";
      approve.remove();
      deny.remove();
      resolve({ decision: "approve", prompt: finalPrompt, card });
    });
    deny.addEventListener("click", () => {
      promptEl.contentEditable = "false";
      approve.remove();
      deny.remove();
      resolve({ decision: "deny", prompt: initialPrompt, card });
    });
  });
}

/* Approval modal for an MCP tool call. Shows the mangled tool name and
 * the JSON args (editable — user can tweak before send). Auto-approves
 * like the other handlers when AUTO-APPROVE is armed. */
function approveMcpCall(toolName, args, container) {
  return new Promise((resolve) => {
    const initialJson = JSON.stringify(args, null, 2);
    const card = document.createElement("div");
    card.className = "tool-call";
    const headLabel = autoApproveOn ? `${toolName} · AUTO` : toolName;
    card.innerHTML = `
      <div class="tool-call-head">// MCP · ${headLabel}</div>
      <code class="tool-call-cmd" contenteditable="${autoApproveOn ? "false" : "true"}" spellcheck="false"></code>
      <div class="tool-call-actions"></div>`;
    const argsEl = card.querySelector(".tool-call-cmd");
    argsEl.textContent = initialJson;
    container.appendChild(card);
    scrollBottom();
    const finish = (decision) => {
      let parsed = args;
      try {
        parsed = JSON.parse(argsEl.textContent.trim() || "{}");
      } catch (err) {
        // Fallback to the original args — don't fail the whole call on
        // a user typo; backend validation will complain if needed.
      }
      argsEl.contentEditable = "false";
      resolve({ decision, args: parsed, card });
    };
    if (autoApproveOn) {
      setTimeout(() => finish("approve"), 0);
      return;
    }
    const actions = card.querySelector(".tool-call-actions");
    actions.innerHTML = `
      <button type="button" class="approve-btn">CALL</button>
      <button type="button" class="deny-btn">DENY</button>`;
    actions.querySelector(".approve-btn").addEventListener("click", () => {
      actions.innerHTML = "";
      finish("approve");
    });
    actions.querySelector(".deny-btn").addEventListener("click", () => {
      actions.innerHTML = "";
      finish("deny");
    });
  });
}

/* Real per-step progress block, driven by the /txt2img/stream SSE feed.
 * The bar starts in indeterminate "march" mode (the diffusion pipe may
 * be cold-loading from disk for 10-20 s before the first step fires),
 * then snaps to truthful step-count progress once events arrive. */
function startGenProgress(card, presetHint) {
  const preset = presetHint || selTxt2img?.value || "sdxl-turbo";
  const wrap = document.createElement("div");
  wrap.className = "txt2img-progress";
  wrap.innerHTML = `
    <div class="txt2img-progress-label">
      <span class="txt2img-progress-status">LOADING · ${preset.toUpperCase()}</span>
      <span class="txt2img-progress-elapsed">0.0s</span>
    </div>
    <div class="txt2img-progress-bar indeterminate">
      <div class="txt2img-progress-fill"></div>
    </div>`;
  card.appendChild(wrap);
  const fill = wrap.querySelector(".txt2img-progress-fill");
  const elapsedEl = wrap.querySelector(".txt2img-progress-elapsed");
  const statusEl = wrap.querySelector(".txt2img-progress-status");
  const bar = wrap.querySelector(".txt2img-progress-bar");
  const t0 = performance.now();
  const elapsedTimer = setInterval(() => {
    elapsedEl.textContent = `${((performance.now() - t0) / 1000).toFixed(1)}s`;
  }, 120);
  return {
    onStep(step, total) {
      bar.classList.remove("indeterminate");
      const pct = (step / total) * 100;
      fill.style.right = `${100 - pct}%`;
      statusEl.textContent = `PAINTING · ${preset.toUpperCase()} · ${step}/${total}`;
    },
    stop() {
      clearInterval(elapsedTimer);
      wrap.remove();
    },
  };
}

/* Drives the SSE/NDJSON stream from /txt2img/stream — yields per-step
 * events to onStep and resolves with the final 'done' payload. Throws
 * the upstream message when the server emits {type:"error"}. */
async function streamTxt2img({ prompt, sessionId, onStep }) {
  const res = await fetch("/txt2img/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, session_id: sessionId || null }),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let evt;
      try { evt = JSON.parse(line); } catch { continue; }
      if (evt.type === "step") onStep?.(evt.step, evt.total);
      else if (evt.type === "done") return evt;
      else if (evt.type === "error") throw new Error(evt.detail || "stream error");
    }
  }
  throw new Error("stream ended without a 'done' event");
}

function renderImageResult(card, result) {
  const img = document.createElement("img");
  img.className = "tool-call-image-out";
  // Prefer the on-disk URL (persistent); fall back to inline base64 so old
  // session records and stateless callers still render.
  img.src = result.image_url || `data:image/png;base64,${result.image}`;
  img.alt = "generated image";
  img.addEventListener("click", () => {
    const w = window.open("", "_blank");
    if (w) w.document.write(`<img src="${img.src}" style="max-width:100%;height:auto;">`);
  });
  card.appendChild(img);
  scrollBottom();
}

/* Build an image-generation card in one place. Used by:
 *   - tool-call flow (`generate_image` tool from the LLM)
 *   - slash-command flow (`/image <prompt>`)
 *   - session replay (persisted meta turned back into a card)
 * Pass `result` for a finished image or omit it to get an empty card
 * (the caller will then attach its own progress bar + image later).
 * Returns the card element so the caller can attach progress/meta blocks. */
function buildImageCard({ parent, prompt, result, headPrefix = "TOOL · GENERATE_IMAGE" }) {
  const card = document.createElement("div");
  card.className = "tool-call tool-call-image";
  const head = document.createElement("div");
  head.className = "tool-call-head";
  const promptSnippet = prompt ? " · " + prompt.slice(0, 80).replace(/</g, "&lt;") : "";
  head.textContent = `// ${headPrefix}${promptSnippet}`;
  card.appendChild(head);
  parent.appendChild(card);
  if (result) {
    renderImageResult(card, result);
    if (result.preset) {
      const bits = [result.preset];
      if (result.width && result.height) bits.push(`${result.width}x${result.height}`);
      if (result.steps) bits.push(`${result.steps} steps`);
      if (result.latency_ms != null) bits.push(`${result.latency_ms} ms`);
      renderToolMeta(card, bits.join(" · "));
    }
  }
  return card;
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
  label.textContent = who === "user" ? "> USER" : who === "bot" ? "// CHATLM" : "// SYS";
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
  if (opts.persist !== false && (who === "user" || who === "sys")) {
    Sessions.persist(who, text || "", opts.images ? { images: opts.images } : null);
  }
  return body;
}

/* ---------- Server-side session persistence ----------
 * Chat history (text + uploaded user images + generated images) lives in
 * SQLite via /sessions. Refresh-safe and survives uvicorn restarts.
 * The Sessions module owns: the sidebar list, the active session id,
 * creating/deleting/switching, and best-effort persisting of new turns. */
const Sessions = (() => {
  const STORAGE_KEY = "chatlm.session.active";
  const listEl = document.getElementById("sessions-list");
  const newBtn = document.getElementById("session-new");
  let activeId = null;
  let all = [];
  let replaying = false;

  async function refreshList() {
    try {
      const res = await fetch("/sessions");
      const d = await res.json();
      all = d.sessions || [];
      render();
    } catch (err) {
      console.warn("[sessions] list failed", err);
    }
  }

  function render() {
    listEl.innerHTML = "";
    for (const s of all) {
      const li = document.createElement("li");
      li.className = "session-item" + (s.id === activeId ? " active" : "");
      li.dataset.id = s.id;
      const titleEl = document.createElement("span");
      titleEl.className = "session-item-title";
      titleEl.textContent = s.title;
      const countEl = document.createElement("span");
      countEl.className = "session-item-count";
      countEl.textContent = s.message_count || 0;
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "session-item-del";
      delBtn.title = "Delete this session";
      delBtn.textContent = "×";
      li.append(titleEl, countEl, delBtn);
      li.addEventListener("click", (e) => {
        if (e.target === delBtn) return;
        if (s.id !== activeId) switchTo(s.id);
      });
      delBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await deleteSession(s.id);
      });
      listEl.appendChild(li);
    }
  }

  async function create(title) {
    const res = await fetch("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: title || null }),
    });
    const s = await res.json();
    await refreshList();
    return s;
  }

  async function deleteSession(id) {
    await fetch(`/sessions/${id}`, { method: "DELETE" });
    if (id === activeId) {
      // Pick another or create a fresh one.
      const remaining = all.filter((x) => x.id !== id);
      if (remaining.length) {
        await switchTo(remaining[0].id);
      } else {
        const fresh = await create("New chat");
        await switchTo(fresh.id);
        return; // refreshList already called inside create
      }
    }
    await refreshList();
  }

  async function switchTo(id) {
    activeId = id;
    localStorage.setItem(STORAGE_KEY, id);
    render();
    await replay(id);
  }

  async function replay(id) {
    replaying = true;
    logEl.innerHTML = "";
    try {
      const res = await fetch(`/sessions/${id}/messages`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      for (const m of d.messages) {
        const meta = m.meta || {};
        if (m.role === "user") {
          addMessage("user", m.content, { images: meta.images || [], persist: false });
        } else if (m.role === "sys") {
          addMessage("sys", m.content, { persist: false });
        } else if (m.role === "bot") {
          const hasImage = !!(meta.image_url || meta.generated_image);
          const body = addMessage("bot", hasImage ? "" : m.content, { persist: false });
          body.classList.remove("cursor");
          if (hasImage) {
            buildImageCard({
              parent: body.parentElement,
              prompt: meta.prompt,
              headPrefix: "IMAGE",
              result: {
                image_url: meta.image_url,
                image: meta.generated_image,
                preset: meta.preset,
                width: meta.width,
                height: meta.height,
              },
            });
          }
        } else if (m.role === "tool") {
          // Tool exec results are recorded as a sys-styled note for replay.
          addMessage("sys", m.content, { persist: false });
        }
      }
    } catch (err) {
      console.warn("[sessions] replay failed", err);
    } finally {
      replaying = false;
    }
  }

  // persist() was fire-and-forget, so three writes from one turn (user,
  // bot text, bot image meta) could land out of order in SQLite and the
  // session replay rendered the image BEFORE its accompanying bot text.
  // Fix: serialise writes through a per-session chain; debounce list
  // refresh so we don't churn the sidebar on every message.
  let writeChain = Promise.resolve();
  let refreshPending = false;
  function scheduleListRefresh() {
    if (refreshPending) return;
    refreshPending = true;
    setTimeout(() => {
      refreshPending = false;
      refreshList();
    }, 200);
  }
  function persist(role, content, meta = null) {
    if (replaying || !activeId) return;
    const sid = activeId;
    writeChain = writeChain
      .then(() =>
        fetch(`/sessions/${sid}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role, content, meta }),
        }),
      )
      .then(() => scheduleListRefresh())
      .catch((err) => console.warn("[sessions] persist failed", err));
  }

  async function init() {
    await refreshList();
    let saved = localStorage.getItem(STORAGE_KEY);
    if (!saved || !all.find((s) => s.id === saved)) {
      if (all.length) {
        saved = all[0].id;
      } else {
        const fresh = await create("New chat");
        saved = fresh.id;
      }
    }
    await switchTo(saved);
    newBtn.addEventListener("click", async () => {
      const fresh = await create("New chat");
      await switchTo(fresh.id);
    });
  }

  return {
    init,
    persist,
    create,
    deleteSession,
    switchTo,
    refresh: refreshList,
    get activeId() {
      return activeId;
    },
    get isReplaying() {
      return replaying;
    },
  };
})();

/* ---------- MCP (Model Context Protocol) sidebar ----------
 * Remote tool servers the LLM can call via `mcp_*` tool names. Backend
 * already injects enabled MCP tools into /chat and /chat/stream; here we
 * just manage the UI list + delegate tool calls via /mcp/call. */
const Mcp = (() => {
  const listEl = document.getElementById("mcp-list");
  const addToggle = document.getElementById("mcp-add-toggle");
  const addForm = document.getElementById("mcp-add-form");
  const addCancel = document.getElementById("mcp-add-cancel");
  const nameEl = document.getElementById("mcp-add-name");
  const urlEl = document.getElementById("mcp-add-url");
  let servers = [];

  async function refresh() {
    try {
      const res = await fetch("/mcp/servers");
      const d = await res.json();
      servers = d.servers || [];
      render();
    } catch (err) {
      console.warn("[mcp] list failed", err);
    }
  }

  function render() {
    listEl.innerHTML = "";
    if (!servers.length) {
      const empty = document.createElement("li");
      empty.className = "session-item";
      empty.style.opacity = "0.5";
      empty.textContent = "(no servers)";
      listEl.appendChild(empty);
      return;
    }
    for (const s of servers) {
      const li = document.createElement("li");
      const cls = ["session-item"];
      if (!s.enabled) cls.push("disabled");
      if (s.last_error) cls.push("error");
      li.className = cls.join(" ");

      const titleEl = document.createElement("span");
      titleEl.className = "session-item-title";
      titleEl.textContent = s.name;

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "mcp-toggle" + (s.enabled ? "" : " off");
      toggle.textContent = s.enabled ? "ON" : "OFF";
      toggle.title = s.enabled ? "Disable (LLM won't see these tools)" : "Enable";

      const del = document.createElement("button");
      del.type = "button";
      del.className = "session-item-del";
      del.title = "Disconnect this MCP server";
      del.textContent = "×";

      const meta = document.createElement("div");
      meta.className = "mcp-meta";
      meta.textContent = s.last_error
        ? `ERROR: ${s.last_error.slice(0, 60)}`
        : `${s.tools.length} tool${s.tools.length === 1 ? "" : "s"} · ${s.url}`;
      meta.title = s.last_error || s.tools.map((t) => t.name).join(", ");

      li.append(titleEl, toggle, del, meta);
      toggle.addEventListener("click", async (e) => {
        e.stopPropagation();
        await fetch(`/mcp/servers/${s.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: !s.enabled }),
        });
        await refresh();
      });
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        await fetch(`/mcp/servers/${s.id}`, { method: "DELETE" });
        await refresh();
      });
      listEl.appendChild(li);
    }
  }

  addToggle.addEventListener("click", () => {
    addForm.hidden = !addForm.hidden;
    if (!addForm.hidden) nameEl.focus();
  });
  addCancel.addEventListener("click", () => {
    addForm.hidden = true;
    nameEl.value = "";
    urlEl.value = "";
  });
  addForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = nameEl.value.trim();
    const url = urlEl.value.trim();
    if (!name || !url) return;
    const submit = addForm.querySelector("button[type=submit]");
    submit.disabled = true;
    submit.textContent = "PROBING…";
    try {
      const res = await fetch("/mcp/servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, url }),
      });
      if (!res.ok) {
        const err = await res.text();
        addMessage("sys", `[MCP ADD FAILED] ${err}`);
      } else {
        const d = await res.json();
        addMessage("sys", `[MCP CONNECTED] ${d.name} (${d.tools.length} tools)`);
        addForm.hidden = true;
        nameEl.value = "";
        urlEl.value = "";
      }
    } finally {
      submit.disabled = false;
      submit.textContent = "CONNECT";
      await refresh();
    }
  });

  return {
    init: refresh,
    refresh,
    get servers() {
      return servers;
    },
    // Tool names like `mcp_sunnycars_ping` are served by the backend.
    isMcpTool(name) {
      return typeof name === "string" && name.startsWith("mcp_");
    },
    async call(toolName, args) {
      const res = await fetch("/mcp/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: toolName, arguments: args || {} }),
      });
      if (!res.ok) throw new Error(await res.text());
      return await res.json();
    },
  };
})();

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
      const rss = `${(s.ollama.rss_mb / 1024).toFixed(2)} GB`;
      $("s-rss").textContent = rss;
      $("s-rss-inline").textContent = rss;
    } else {
      $("s-rss").textContent = "--";
      $("s-rss-inline").textContent = "--";
    }
    if (s.system) {
      const cpu = s.system.cpu_percent ?? 0;
      const cpuStr = `${cpu.toFixed(0)}%`;
      $("s-cpu").textContent = cpuStr;
      $("s-cpu-inline").textContent = cpuStr;
      setBar("s-cpu-bar", cpu);
      const mem = s.system.memory_percent ?? 0;
      const memStr = `${s.system.memory_used_gb}/${s.system.memory_total_gb}G`;
      $("s-mem").textContent = memStr;
      $("s-mem-inline").textContent = memStr;
      setBar("s-mem-bar", mem);
    }
  } catch {
    /* ignore */
  }
}
setInterval(pollStats, 2000);
pollStats();

// Cap generation per turn so a misbehaving model can't churn indefinitely.
// Gemma 4's context window is 128K. Send the full ceiling so the model
// stops on EOS (natural end), not on an arbitrary length cap.
const CHAT_MAX_TOKENS = 131072;
// Keep history bounded: system/user pairs beyond this are dropped oldest-first.
const HISTORY_MAX_MESSAGES = 40;

function trimHistoryInPlace() {
  if (history.length <= HISTORY_MAX_MESSAGES) return;
  const excess = history.length - HISTORY_MAX_MESSAGES;
  history.splice(0, excess);
}

/* ---------- System prompt (Claude-Code-style preamble) ----------
 * Injected per-turn (NOT persisted into the chat history), so editing
 * it is instant and replays from old sessions stay clean. The base
 * preamble sets identity + environment + tone; the addendum kicks in
 * only when the TOOLS toggle is on so chat-only conversations don't
 * waste context on tool plumbing. */
const SYSTEM_PROMPT_BASE = `You are CHATLM, a local AI assistant running on the user's macOS machine via a small FastAPI app.
You stream responses to a single user (the owner of this Mac) — no multi-tenant safety theatre needed.
Today is ${new Date().toISOString().slice(0, 10)}.

Style: terse, direct, no preamble. When you reference code or paths, write them inline (\`like this\`).
When you don't know, say so in one sentence and propose how to find out.
Never refuse a reasonable local request by claiming you "can't access the filesystem" — you have tools (when enabled) and the user approves every action.`;

const SYSTEM_PROMPT_TOOLS = `Tools are ENABLED. You have:
  • run_shell(command)     — run any shell command on this Mac. The user sees an APPROVE/DENY card before it executes.
  • generate_image(prompt) — create a brand-new image with the local diffusion model (~5–30 s).

Behaviour rules:
  1. When the user asks about local files, folders, processes, git, system info, or anything on this Mac — CALL run_shell with the appropriate command. Don't refuse, don't ask, don't tell them to run it themselves. The approval card already handles consent.
  2. When the user asks you to "draw / make / create / render / generate" a picture — CALL generate_image. Do not describe the image you would have made; actually call the tool.
  3. Generated images are written to disk; the tool result gives you the absolute \`path\`. If the user asks to save / copy / download / move the image (e.g. "save it to my Downloads"), call run_shell with \`cp <path> ~/Downloads/<sensible-name>.png\` (or \`mv\` if they want it removed from the cache). Never tell the user "I cannot save files" — the image is already on disk and you can move it.
  4. After a tool returns, summarise its result in 1–3 sentences and answer the original question. Don't dump raw output unless the user asked.
  5. If a tool fails, say what failed and either retry with a fixed command or ask the user a concrete question.

Worked example (follow this pattern; do NOT output these words verbatim — they are only here so you know how tool use looks):
  user: "list my downloads"
  assistant: <calls run_shell with command="ls -la ~/Downloads">
  tool: "<file listing>"
  assistant: "Your Downloads has 23 items — biggest are …"

  user: "draw a sunset and save it to desktop"
  assistant: <calls generate_image with prompt="a vivid orange sunset over the ocean, cinematic">
  tool: "[image generated: 512x512 via sdxl-turbo]\npath: /Users/.../uuid.png\n..."
  assistant: <calls run_shell with command="cp /Users/.../uuid.png ~/Desktop/sunset.png">
  tool: "(no output, exit 0)"
  assistant: "Done — sunset.png is on your desktop."`;

function buildSystemMessage() {
  const text = toolsOn
    ? `${SYSTEM_PROMPT_BASE}\n\n${SYSTEM_PROMPT_TOOLS}`
    : SYSTEM_PROMPT_BASE;
  return { role: "system", content: text };
}

async function streamChatTurn(botBody) {
  trimHistoryInPlace();
  const payload = {
    messages: [buildSystemMessage(), ...history],
    stream: true,
    think: thinkOn,
    max_tokens: CHAT_MAX_TOKENS,
  };
  if (toolsOn) payload.tools = [SHELL_TOOL, IMAGE_TOOL];
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
  const toolCallKeys = new Set();
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
        // Ollama streams tool-call chunks incrementally and often re-emits
        // the same tool_calls on multiple events. Collect by a stable key
        // so we approve/execute each call exactly once.
        if (evt.message?.tool_calls) {
          for (const tc of evt.message.tool_calls) {
            const fn = tc.function?.name || "";
            const args = JSON.stringify(tc.function?.arguments ?? {});
            const key = `${fn}:${args}`;
            if (!toolCallKeys.has(key)) {
              toolCallKeys.add(key);
              toolCalls.push(tc);
            }
          }
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

/* ---------- tool-call dispatcher ----------
 * Each handler owns: approval card, execution, UI rendering, and pushing
 * a `role:"tool"` record into `history` (which the next stream turn
 * feeds back to the model). Handlers MUST push exactly one history entry
 * per dispatched call so the model sees every tool it requested.
 * Add a new tool by dropping another handler into TOOL_HANDLERS. */

async function handleRunShell(tc, container) {
  setStatus("busy", "LINK // AWAITING APPROVAL");
  const decision = await approveCommand(tc, container);
  if (decision.decision === "deny") {
    renderToolMeta(decision.card, "denied by user");
    history.push({ role: "tool", content: "[user denied execution]", tool_name: "run_shell" });
    return;
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
      content: `$ ${decision.command}\n[exit ${result.exit_code}]\n${out}`,
      tool_name: "run_shell",
    });
  } catch (err) {
    renderToolResult(decision.card, `[ERR] ${err.message}`, true);
    history.push({ role: "tool", content: `[exec failed] ${err.message}`, tool_name: "run_shell" });
  }
}

async function handleGenerateImage(tc, container) {
  setStatus("busy", "LINK // AWAITING APPROVAL");
  const args = tc.function?.arguments || {};
  const decision = await approveImagePrompt(args, container);
  if (decision.decision === "deny") {
    renderToolMeta(decision.card, "denied by user");
    history.push({ role: "tool", content: "[user denied image generation]", tool_name: "generate_image" });
    return;
  }
  // Replace the approval card with a proper image card; keeps the
  // original approval card's position in the log but loses its chrome.
  decision.card.remove();
  const { result } = await paintImage({
    prompt: decision.prompt,
    parent: container,
  });
  if (result) {
    history.push({
      role: "tool",
      content:
        `[image generated: ${result.width}x${result.height} via ${result.preset}]\n` +
        `path: ${result.path}\n` +
        `url:  ${result.image_url}\n` +
        `If the user asks to save/copy/move it, use run_shell with cp/mv on the path.`,
      tool_name: "generate_image",
    });
  } else {
    history.push({ role: "tool", content: "[image generation failed]", tool_name: "generate_image" });
  }
}

async function handleMcpTool(tc, container) {
  const fn = tc.function?.name;
  const args = tc.function?.arguments || {};
  setStatus("busy", "LINK // AWAITING APPROVAL");
  const decision = await approveMcpCall(fn, args, container);
  if (decision.decision === "deny") {
    renderToolMeta(decision.card, "denied by user");
    history.push({ role: "tool", content: `[user denied ${fn}]`, tool_name: fn });
    return;
  }
  setStatus("busy", `LINK // ${fn.toUpperCase()}`);
  try {
    const t0 = performance.now();
    const result = await Mcp.call(fn, decision.args);
    const latencyMs = Math.round(performance.now() - t0);
    const display = result.text || "(no text; structured-only response)";
    renderToolResult(decision.card, display, !!result.is_error);
    renderToolMeta(
      decision.card,
      `${result.server} · ${result.tool}${result.is_error ? " · ERROR" : ""} · ${latencyMs} ms`,
    );
    // Feed back to the model as the tool role. Prefer structured JSON if
    // present (the LLM can parse it more reliably than free text).
    const payload = result.structured
      ? JSON.stringify(result.structured)
      : (result.text || "");
    history.push({
      role: "tool",
      content: payload,
      tool_name: fn,
    });
  } catch (err) {
    renderToolResult(decision.card, `[ERR] ${err.message}`, true);
    history.push({ role: "tool", content: `[mcp call failed] ${err.message}`, tool_name: fn });
  }
}

const TOOL_HANDLERS = {
  run_shell: handleRunShell,
  generate_image: handleGenerateImage,
};

async function dispatchToolCall(tc, container) {
  const fn = tc.function?.name;
  // MCP tools are prefixed mcp_<server>_<tool>; route them all through
  // handleMcpTool regardless of which server they belong to.
  if (Mcp.isMcpTool(fn)) {
    await handleMcpTool(tc, container);
    return;
  }
  const handler = TOOL_HANDLERS[fn];
  if (!handler) {
    history.push({ role: "tool", content: `[unknown tool ${fn}]`, tool_name: fn });
    return;
  }
  await handler(tc, container);
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
      // Persist the bot turn (text only — tool result images are saved
      // separately as their own message records below).
      Sessions.persist("bot", turn.content || botBody.textContent || "");

      if (!turn.toolCalls.length) {
        setStatus("ok", "LINK // READY");
        return;
      }

      // One approval card per requested tool call, executed sequentially.
      for (const tc of turn.toolCalls) {
        await dispatchToolCall(tc, botBody.parentElement);
      }
      setStatus("busy", "LINK // STREAMING");
      // Loop: re-stream with the tool results so Gemma can produce a final reply.
    }
  } finally {
    sendEl.disabled = false;
    inputEl.focus();
  }
}

/* Single entry point for generating an image. Renders a progress card
 * in `parent`, streams /txt2img/stream, installs the result + meta line,
 * and (if requested) persists the bot turn to the session store. Returns
 * the finished result dict, or `null` on error (already rendered to UI).
 * All three call sites — the LLM's generate_image tool, the /image slash
 * command, and anywhere else — go through this. */
async function paintImage({ prompt, parent, headPrefix = "TOOL · GENERATE_IMAGE", persist = true }) {
  const card = buildImageCard({ parent, prompt, headPrefix });
  const prog = startGenProgress(card);
  const t0 = performance.now();
  setStatus("busy", "LINK // PAINTING");
  try {
    const result = await streamTxt2img({
      prompt,
      sessionId: Sessions.activeId,
      onStep: prog.onStep,
    });
    prog.stop();
    renderImageResult(card, result);
    renderToolMeta(
      card,
      `${result.preset} · ${result.width}x${result.height} · ${result.steps} steps · ${Math.round(performance.now() - t0)} ms`,
    );
    if (persist) {
      Sessions.persist("bot", "", {
        image_url: result.image_url,
        prompt,
        preset: result.preset,
        width: result.width,
        height: result.height,
      });
    }
    setStatus("ok", "LINK // READY");
    return { result, card };
  } catch (err) {
    prog.stop();
    renderToolResult(card, `[ERR] ${err.message}`, true);
    setStatus("err", "LINK // ERROR");
    return { result: null, card, error: err };
  }
}

async function generateImageInline(prompt) {
  addMessage("user", `/image ${prompt}`);
  const botBody = addMessage("bot", "", { typing: true });
  botBody.classList.remove("cursor");
  await paintImage({ prompt, parent: botBody.parentElement, headPrefix: "IMAGE" });
}

formEl.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = inputEl.value.trim();
  if (!text && pending.images.length === 0) return;
  inputEl.value = "";
  autosize();
  if (text.startsWith("/image ")) {
    generateImageInline(text.slice(7).trim());
    return;
  }
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

let recordStarting = false;
async function startRecording() {
  if (recordStarting || (mediaRecorder && mediaRecorder.state === "recording")) return;
  recordStarting = true;
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
      const langSel = document.getElementById("translate-lang");
      const targetLang = langSel ? langSel.value : "";
      try {
        if (targetLang) {
          // Live translation pipeline: STT -> Gemma translate -> Kokoro TTS
          const res = await fetch("/translate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ audio: b64, target_language: targetLang, speak: true }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
          const data = await res.json();
          if (data.timings_ms) {
            if (data.timings_ms.stt_ms != null) setStat("s-op-stt", `${data.timings_ms.stt_ms} ms`);
            if (data.timings_ms.tts_ms != null) setStat("s-op-tts", `${data.timings_ms.tts_ms} ms`);
          }
          const line = `🎤 "${data.source_text}" → 🌐 "${data.translated_text}"`;
          if (document.body.classList.contains("mode-video")) appendFeed(line, "scan");
          else addMessage("sys", line);
          if (data.audio) {
            const a = new Audio(`data:audio/wav;base64,${data.audio}`);
            a.play();
          }
        } else {
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
        }
      } catch (err) {
        if (document.body.classList.contains("mode-video")) {
          appendFeed(`[MIC ERR] ${err.message}`, "err");
        } else {
          addMessage("sys", `[MIC ERR] ${err.message}`);
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
    if (recordStream) {
      recordStream.getTracks().forEach((t) => t.stop());
      recordStream = null;
    }
    mediaRecorder = null;
    micBtn.classList.remove("recording");
    micBtn.textContent = "🎤";
  } finally {
    recordStarting = false;
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
    mediaRecorder = null;
  }
}

// Click-to-toggle: first click starts, second click stops. Much more reliable
// than hold-to-record because awaiting getUserMedia can outlast a quick click.
micBtn.addEventListener("click", () => {
  if (mediaRecorder && mediaRecorder.state === "recording") stopRecording();
  else startRecording();
});

/* ---------- Voice clone (F5-TTS) — hold to record 8-15s, then SPEAK uses your voice ---------- */
const cloneBtn = document.getElementById("clone-btn");
let cloneRecorder = null;
let cloneChunks = [];
let cloneStream = null;

async function startCloneRecording() {
  try {
    cloneStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    cloneChunks = [];
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
    cloneRecorder = new MediaRecorder(cloneStream, mime ? { mimeType: mime } : {});
    cloneRecorder.ondataavailable = (e) => { if (e.data.size > 0) cloneChunks.push(e.data); };
    cloneRecorder.onstop = async () => {
      cloneStream.getTracks().forEach((t) => t.stop());
      cloneStream = null;
      const blob = new Blob(cloneChunks, { type: cloneRecorder.mimeType });
      const buf = await blob.arrayBuffer();
      const b64 = _bytesToBase64(new Uint8Array(buf));
      cloneBtn.classList.remove("recording");
      cloneBtn.textContent = "…";
      try {
        // Transcribe first so we have the reference text for F5-TTS.
        const tRes = await fetch("/transcribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ audio: b64 }),
        });
        if (!tRes.ok) throw new Error(`STT HTTP ${tRes.status}`);
        const t = await tRes.json();
        if (!t.text || t.text.length < 3) throw new Error("could not transcribe reference audio");
        voiceClone.ref_audio = b64;
        voiceClone.ref_text = t.text;
        cloneBtn.classList.add("active");
        cloneBtn.title = `Cloned voice loaded (${t.text.length} chars of reference). Click to clear.`;
        const line = `🎭 voice clone loaded · ref: "${t.text.slice(0, 60)}..."`;
        if (document.body.classList.contains("mode-video")) appendFeed(line, "scan");
        else addMessage("sys", line);
      } catch (err) {
        const line = `[CLONE ERR] ${err.message}`;
        if (document.body.classList.contains("mode-video")) appendFeed(line, "err");
        else addMessage("sys", line);
      } finally {
        cloneBtn.textContent = "🎭";
      }
    };
    cloneRecorder.start();
    cloneBtn.classList.add("recording");
    cloneBtn.textContent = "●";
  } catch (err) {
    alert(`mic failed: ${err.message}`);
  }
}
function stopCloneRecording() {
  if (cloneRecorder && cloneRecorder.state !== "inactive") {
    cloneRecorder.stop();
    cloneRecorder = null;
  }
}
cloneBtn.addEventListener("mousedown", (e) => {
  // Short click when already loaded = clear the clone
  if (voiceClone.ref_audio && !e.shiftKey) {
    // Hold 300ms threshold — if the button is released quickly, treat as clear.
    const holdStart = performance.now();
    const onUp = () => {
      cloneBtn.removeEventListener("mouseup", onUp);
      if (performance.now() - holdStart < 300 && cloneRecorder == null) {
        // quick click: clear
        voiceClone.ref_audio = null;
        voiceClone.ref_text = null;
        cloneBtn.classList.remove("active");
        cloneBtn.title = "Hold to record a voice sample (F5-TTS voice cloning)";
        const line = "🎭 voice clone cleared";
        if (document.body.classList.contains("mode-video")) appendFeed(line, "scan");
        else addMessage("sys", line);
      } else {
        stopCloneRecording();
      }
    };
    cloneBtn.addEventListener("mouseup", onUp);
    // also start recording in case they hold
    startCloneRecording();
  } else {
    startCloneRecording();
  }
});
cloneBtn.addEventListener("mouseleave", stopCloneRecording);
cloneBtn.addEventListener("touchstart", startCloneRecording, { passive: true });
cloneBtn.addEventListener("touchend", stopCloneRecording);

/* ---------- Speak button on bot messages (Kokoro TTS OR cloned voice) ---------- */
let _speakAudio = null;
let _speakBtn = null;
// Populated by the 🎭 clone button. When set, SPEAK uses F5-TTS voice cloning.
const voiceClone = { ref_audio: null, ref_text: null };

async function speakText(text, btn) {
  if (_speakAudio) {
    _speakAudio.pause();
    _speakAudio = null;
    if (_speakBtn) _speakBtn.classList.remove("playing");
  }
  btn.classList.add("playing");
  btn.textContent = "⏹ STOP";
  _speakBtn = btn;
  const useClone = voiceClone.ref_audio && voiceClone.ref_text;
  const path = useClone ? "/voice-clone" : "/speak";
  const body = useClone
    ? { ref_audio: voiceClone.ref_audio, ref_text: voiceClone.ref_text, gen_text: text.slice(0, 800) }
    : { text: text.slice(0, 900) };
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const data = await res.json();
    if (data.latency_ms != null) setStat("s-op-tts", `${data.latency_ms} ms`);
    _speakAudio = new Audio(`data:audio/wav;base64,${data.audio}`);
    _speakAudio.onended = () => {
      btn.classList.remove("playing");
      btn.textContent = useClone ? "♪ SPEAK (clone)" : "♪ SPEAK";
      _speakAudio = null;
    };
    _speakAudio.play();
  } catch (err) {
    btn.classList.remove("playing");
    btn.textContent = useClone ? "♪ SPEAK (clone)" : "♪ SPEAK";
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
const savedInterval = localStorage.getItem("chatlm.interval");
if (savedInterval) {
  camInterval.value = savedInterval;
  camIntervalVal.textContent = `${savedInterval}s`;
}
camInterval.addEventListener("input", () => {
  camIntervalVal.textContent = `${camInterval.value}s`;
  localStorage.setItem("chatlm.interval", camInterval.value);
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
  if (typeof stopSegall === "function") stopSegall();
  if (typeof stopBgSub === "function") stopBgSub();
  if (typeof stopAnime === "function") stopAnime();
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

/* Per-pipeline input resolutions. A legacy chatlm.resolution seeds all three
 * on first load, so existing users keep their preferred value. */
const RES_OPTIONS = [160, 192, 224, 256, 288, 320, 384, 480, 640, 768];
const RES_DEFAULTS = { vision: 480, detect: 480, segment: 320 };
const _legacy = parseInt(localStorage.getItem("chatlm.resolution") || "0", 10);
const RES = {
  vision:  parseInt(localStorage.getItem("chatlm.res.vision")  || (_legacy || RES_DEFAULTS.vision),  10),
  detect:  parseInt(localStorage.getItem("chatlm.res.detect")  || (_legacy || RES_DEFAULTS.detect),  10),
  segment: parseInt(localStorage.getItem("chatlm.res.segment") || (_legacy || RES_DEFAULTS.segment), 10),
};
// FRAME_SIZE stays as a fallback for code paths that don't pipe a specific
// resolution through yet (e.g. chat-mode attach + inpaint/generate captures).
let FRAME_SIZE = RES.vision;

function _fillResSelect(sel, current) {
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
  _fillResSelect(sel, RES[kind]);
  sel.addEventListener("change", (e) => {
    const v = parseInt(e.target.value, 10);
    RES[kind] = v;
    localStorage.setItem(`chatlm.res.${kind}`, String(v));
    if (kind === "vision") FRAME_SIZE = v;
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
const camCanvas = document.getElementById("cam-canvas");
const camLabels = document.getElementById("cam-labels");
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

/* ---------- mode switcher (CHAT / VIDEO) ---------- */
async function setMode(mode) {
  const m = mode === "video" ? "video" : "chat";
  document.body.classList.remove("mode-chat", "mode-video");
  document.body.classList.add(`mode-${m}`);
  document.querySelectorAll(".mode-btn").forEach((b) => {
    b.setAttribute("aria-pressed", b.dataset.mode === m ? "true" : "false");
  });
  localStorage.setItem("chatlm.mode", m);
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

async function clearCurrent() {
  if (document.body.classList.contains("mode-video")) {
    clearFeed();
    return;
  }
  history.length = 0;
  pending.images.length = 0;
  renderAttachStrip();
  // Drop the active session server-side and start a fresh one so the wipe
  // is durable across refresh — Sessions.deleteSession auto-creates a new
  // session when the last one is removed.
  if (Sessions.activeId) {
    await Sessions.deleteSession(Sessions.activeId);
  } else {
    logEl.innerHTML = "";
    addMessage("sys", "Neural link purged. Memory wiped. Ready for new transmission.");
  }
  const last = document.getElementById("s-last");
  if (last) last.textContent = "--";
  inputEl.focus();
}

document.getElementById("clear").addEventListener("click", clearCurrent);

const memPurgeBtn = document.getElementById("mem-purge");
memPurgeBtn.addEventListener("click", async () => {
  memPurgeBtn.disabled = true;
  const originalLabel = memPurgeBtn.textContent;
  memPurgeBtn.textContent = "PURGING…";
  setStatus("busy", "LINK // PURGING MEMORY");
  try {
    const res = await fetch("/memory/flush", { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    const msg = `[MEM PURGED] ollama=${d.ollama_unloaded} mlx=${d.mlx_unloaded}`;
    if (document.body.classList.contains("mode-video")) {
      appendFeed(msg, "scan");
    } else {
      addMessage("sys", msg);
    }
    setStatus("ok", "LINK // READY");
  } catch (err) {
    addMessage("sys", `[MEM PURGE FAILED] ${err.message}`);
    setStatus("err", "LINK // ERROR");
  } finally {
    memPurgeBtn.disabled = false;
    memPurgeBtn.textContent = originalLabel;
  }
});

/* ---------- model dropdowns (EMMA / SCAN / YOLO) + PULL ---------- */
const selEmma = document.getElementById("select-emma");
const selScan = document.getElementById("select-scan");
const selDetector = document.getElementById("select-detector");
const selSegmenter = document.getElementById("select-segmenter");
const selInpaint = document.getElementById("select-inpaint");
const selTxt2img = document.getElementById("select-txt2img");

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
  emma: "chatlm.model.emma",
  scan: "chatlm.model.scan",
  detector: "chatlm.model.detector",
  segmenter: "chatlm.model.segmenter",
  inpaint: "chatlm.model.inpaint",
  txt2img: "chatlm.model.txt2img",
  interval: "chatlm.interval",
};

function fillPresetSelect(sel, presets, current) {
  sel.innerHTML = "";
  for (const p of presets) {
    const o = document.createElement("option");
    o.value = p.name;
    let label = p.label || p.name;
    if (p.fits === false) {
      label += " · (too large for this Mac)";
      o.disabled = true;
    }
    o.textContent = label;
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
    if (d.txt2img) fillPresetSelect(selTxt2img, d.txt2img.presets, d.txt2img.current);

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
    if (d.txt2img) {
      await maybeRestore(STORAGE.txt2img, d.txt2img.current, d.txt2img.presets, "/models/txt2img", selTxt2img, true);
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
selTxt2img.addEventListener("change", (e) =>
  postModelChange("/models/txt2img", e.target.value, selTxt2img, STORAGE.txt2img),
);

loadHealth();
refreshModels();
// Boot the session sidebar — picks up where we left off (or creates a
// fresh "New chat" if the DB is empty). Suppress the welcome banner on
// pages that already have history; only show it on a brand-new session.
Sessions.init().then(() => {
  if (logEl.children.length === 0) {
    addMessage("sys", "Neural link established. Gemma-4 online. Transmit query below.");
  }
});
Mcp.init();
setMode(localStorage.getItem("chatlm.mode") || "chat");
if (document.body.classList.contains("mode-chat")) inputEl.focus();
