/* messages.js
 * Renders chat log rows. Kept minimal so every other module can import
 * addMessage() without pulling heavy feature deps. Persistence for
 * user/sys turns is delegated to Sessions (via circular import — safe
 * because Sessions.persist is only called at runtime, not module init). */

import { logEl, scrollBottom } from "./core.js";
import { Sessions } from "./sessions.js";
import { renderMarkdown } from "./markdown.js";

export function addMessage(who, text, opts = {}) {
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
  if (text) {
    // Render bot responses as markdown (tables, code, lists); user/sys
    // stay as plain text so user input isn't accidentally interpreted.
    if (who === "bot") body.innerHTML = renderMarkdown(text);
    else body.appendChild(document.createTextNode(text));
  }
  if (opts.typing) body.classList.add("cursor");
  wrap.appendChild(label);
  wrap.appendChild(body);
  logEl.appendChild(wrap);
  scrollBottom();
  // Only user/sys turns persist here; bot turns are persisted by chat.js
  // after streaming completes so the final text is the saved text.
  if (opts.persist !== false && (who === "user" || who === "sys")) {
    Sessions.persist(who, text || "", opts.images ? { images: opts.images } : null);
  }
  return body;
}

export function renderToolResult(card, result, isError, opts = {}) {
  if (opts.asMarkdown && !isError) {
    // MCP servers typically return pre-formatted markdown (tables, lists,
    // links). Render it with the chat's markdown stylesheet instead of
    // the monospace <pre> used for shell stdout.
    const div = document.createElement("div");
    div.className = "tool-call-result tool-call-result-md";
    div.innerHTML = renderMarkdown(result);
    card.appendChild(div);
  } else {
    const pre = document.createElement("pre");
    pre.className = "tool-call-result" + (isError ? " err" : "");
    pre.textContent = result;
    card.appendChild(pre);
  }
  scrollBottom();
}

export function renderToolMeta(card, text) {
  const meta = document.createElement("div");
  meta.className = "tool-call-meta";
  meta.textContent = text;
  card.appendChild(meta);
}
