/* txt2img.js
 * Text-to-image generation: per-step progress bar, SSE stream client,
 * card renderer, and the single public entry point `paintImage` used by
 * both the /image slash-command and the LLM's generate_image tool. */

import { scrollBottom, setStatus } from "./core.js";
import { renderToolMeta, renderToolResult, addMessage } from "./messages.js";
import { pending } from "./state.js";
import { Sessions } from "./sessions.js";

/* Real per-step progress block, driven by the /txt2img/stream SSE feed.
 * The bar starts in indeterminate "march" mode (the diffusion pipe may
 * be cold-loading from disk for 10-20 s before the first step fires),
 * then snaps to truthful step-count progress once events arrive. */
export function startGenProgress(card, presetHint) {
  const selTxt2img = document.getElementById("select-txt2img");
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

/* Drives the NDJSON stream from /txt2img/stream — yields per-step events
 * to onStep and resolves with the final 'done' payload. Throws the
 * upstream message when the server emits {type:"error"}. */
export async function streamTxt2img({ prompt, sessionId, onStep }) {
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

export function renderImageResult(card, result) {
  const img = document.createElement("img");
  img.className = "tool-call-image-out";
  // Prefer the on-disk URL (persistent); fall back to inline base64 so
  // old session records and stateless callers still render.
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
 * (caller then attaches its own progress bar + image later). */
export function buildImageCard({ parent, prompt, result, headPrefix = "TOOL · GENERATE_IMAGE" }) {
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

/* Single entry point for generating an image. Renders a progress card
 * in `parent`, streams /txt2img/stream, installs the result + meta line,
 * and (if requested) persists the bot turn to the session store. Returns
 * {result, card} on success; {result:null, card, error} on failure. */
export async function paintImage({ prompt, parent, headPrefix = "TOOL · GENERATE_IMAGE", persist = true }) {
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

// Slash-command handler — `/image a red fox` goes through here.
export async function generateImageInline(prompt) {
  addMessage("user", `/image ${prompt}`);
  const botBody = addMessage("bot", "", { typing: true });
  botBody.classList.remove("cursor");
  await paintImage({ prompt, parent: botBody.parentElement, headPrefix: "IMAGE" });
}
