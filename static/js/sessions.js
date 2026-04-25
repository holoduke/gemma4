/* sessions.js
 * Sidebar + persistence for chat sessions. Mirrors the SQLite-backed
 * /sessions API: fetch list, create, delete, rename, append message,
 * replay on switch. Circular imports with messages.js / txt2img.js are
 * safe — all cross-module accesses happen inside function bodies. */

import { logEl } from "./core.js";
import { STORAGE_KEYS, history } from "./state.js";
// Lazy imports for replay (see replay() body) to avoid TDZ at init.

export const Sessions = (() => {
  const STORAGE_KEY = STORAGE_KEYS.session;
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
    // Dynamic imports so the module graph can finish init before we
    // touch addMessage / buildImageCard (which import us back).
    const [{ addMessage, renderToolResult, renderToolMeta }, { buildImageCard }] = await Promise.all([
      import("./messages.js"),
      import("./txt2img.js"),
    ]);
    replaying = true;
    logEl.innerHTML = "";
    // Also rebuild the in-memory chat history so the LLM has context
    // after a page refresh. Without this, /chat/stream on the next turn
    // sees a blank conversation and the model "forgets" everything.
    history.length = 0;
    try {
      const res = await fetch(`/sessions/${id}/messages`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      for (const m of d.messages) {
        const meta = m.meta || {};
        if (m.role === "user") {
          addMessage("user", m.content, { images: meta.images || [], persist: false });
          // Skip re-attaching images in history — they'd bloat the
          // prompt on every subsequent turn. Bot's past summaries
          // already describe them in text.
          if (m.content) history.push({ role: "user", content: m.content });
        } else if (m.role === "sys") {
          addMessage("sys", m.content, { persist: false });
        } else if (m.role === "bot") {
          const hasImage = !!(meta.image_url || meta.generated_image);
          // Replay-time content fallbacks so empty rows don't render
          // as a confusingly-blank "// CHATLM" bubble.
          let displayContent = m.content;
          if (!hasImage && !displayContent) {
            if (meta.streaming) {
              displayContent = "_[stream interrupted before response landed]_";
            } else if (meta.error) {
              displayContent = m.content || "_[stream errored]_";
            } else if (meta.tool_calls && meta.tool_calls.length) {
              const names = meta.tool_calls.map(
                (t) => t.function?.name || "?",
              ).join(", ");
              displayContent = `_[called ${names} — see tool result below]_`;
            }
          }
          const body = addMessage("bot", hasImage ? "" : displayContent, { persist: false });
          body.classList.remove("cursor");
          // Reasoning was live-rendered above the bot body during the
          // original turn; replay it collapsed — the detail matters for
          // audit but should not dominate the replay view.
          if (meta.thinking) {
            const det = document.createElement("details");
            det.className = "thought";
            const sum = document.createElement("summary");
            sum.textContent = "REASONING";
            const tb = document.createElement("div");
            tb.className = "thought-body";
            const { renderMarkdown } = await import("./markdown.js");
            tb.innerHTML = renderMarkdown(meta.thinking);
            det.append(sum, tb);
            body.parentElement.insertBefore(det, body);
          }
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
            // Record image-generation turns as a compact assistant note
            // so the model knows what it painted, without re-sending the
            // full image.
            if (meta.prompt) {
              history.push({
                role: "assistant",
                content: `[generated image: ${meta.prompt}]`,
              });
            }
          } else if (m.content || meta.tool_calls) {
            // Include tool_calls on assistant entries so subsequent
            // role:"tool" entries have something to respond to (models
            // error out on orphan tool responses).
            const entry = { role: "assistant", content: m.content || "" };
            if (meta.tool_calls) entry.tool_calls = meta.tool_calls;
            history.push(entry);
          }
        } else if (m.role === "tool") {
          // LLM context: push as-is with tool_name.
          history.push({
            role: "tool",
            content: m.content,
            tool_name: meta.tool_name || "",
          });
          // UI: render as a tool-call card so the replay looks like the
          // live session, not a bland sys-note.
          const card = document.createElement("div");
          card.className = "tool-call";
          const head = document.createElement("div");
          head.className = "tool-call-head";
          head.textContent = `// ${(meta.tool_name || "TOOL").toUpperCase()}`;
          card.appendChild(head);
          logEl.appendChild(card);
          // MCP tool turns stored `.text` in meta — render the original
          // markdown. Everything else (run_shell, generate_image errors)
          // falls through to the monospace pre.
          const asMd = meta.is_mcp && meta.text;
          renderToolResult(card, asMd ? meta.text : m.content, false, { asMarkdown: !!asMd });
          if (meta.tool_name) {
            const bits = [meta.tool_name];
            if (meta.server) bits.unshift(meta.server);
            if (meta.command) bits.push(meta.command.slice(0, 60));
            if (meta.exit_code != null) bits.push(`exit ${meta.exit_code}`);
            renderToolMeta(card, bits.join(" · "));
          }
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

  /* Same as persist() but returns the row's id, so the caller can
   * later patch it (in-progress placeholder → final content). Still
   * goes through writeChain so it doesn't reorder vs. fire-and-forget
   * persists queued before it. */
  async function persistAwait(role, content, meta = null) {
    if (replaying || !activeId) return null;
    const sid = activeId;
    let resolved = null;
    writeChain = writeChain.then(async () => {
      try {
        const res = await fetch(`/sessions/${sid}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role, content, meta }),
        });
        if (res.ok) resolved = await res.json();
        scheduleListRefresh();
      } catch (err) {
        console.warn("[sessions] persistAwait failed", err);
      }
    });
    await writeChain;
    return resolved;  // shape: { id, session_id, role, content, meta, created_at }
  }

  /* Patch an existing row's content + meta (e.g. swap streaming
   * placeholder for the final response). Best-effort; failures log. */
  function update(messageId, content, meta = null) {
    if (!activeId || messageId == null) return;
    const sid = activeId;
    writeChain = writeChain
      .then(() =>
        fetch(`/sessions/${sid}/messages/${messageId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content, meta }),
        }),
      )
      .then(() => scheduleListRefresh())
      .catch((err) => console.warn("[sessions] update failed", err));
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
    persistAwait,
    update,
    create,
    deleteSession,
    switchTo,
    refresh: refreshList,
    get activeId() { return activeId; },
    get isReplaying() { return replaying; },
  };
})();
