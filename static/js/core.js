/* core.js
 * DOM references and cross-module helpers: status pill, scroll/log,
 * stat-tile setters, tiny utilities. No feature logic here — anything
 * more than ~5 lines belongs in its own module. */

export const logEl = document.getElementById("log");
export const formEl = document.getElementById("form");
export const inputEl = document.getElementById("input");
export const sendEl = document.getElementById("send");
export const statusEl = document.querySelector(".status");
export const statusText = document.getElementById("status-text");
export const modelEl = document.getElementById("model-name");

export const $ = (id) => document.getElementById(id);

export function setStatus(state, text) {
  statusEl.classList.remove("busy", "err");
  if (state === "busy") statusEl.classList.add("busy");
  if (state === "err") statusEl.classList.add("err");
  statusText.textContent = text;
}

export function scrollBottom() {
  logEl.scrollTop = logEl.scrollHeight;
}

export function setStat(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
  // Any of the video-pipeline tiles changing triggers a total recompute.
  if (["s-live", "s-scan", "s-yolo", "s-sam"].includes(id)) recomputeTotal();
}

export function parseMs(txt) {
  if (!txt) return null;
  const m = String(txt).match(/(\d+(?:\.\d+)?)\s*ms/);
  return m ? parseFloat(m[1]) : null;
}

export function recomputeTotal() {
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

export function setBar(id, pct) {
  const el = $(id);
  if (el) el.style.width = `${Math.min(100, Math.max(0, pct)).toFixed(0)}%`;
}
