/* attach.js
 * File/image attachments: button, paste, resize pipeline. Produces the
 * base64 JPEGs queued in state.pending for the next user turn. */

import { pending, FRAME_SIZE } from "./state.js";

const attachInput = document.getElementById("attach-input");
const attachBtn = document.getElementById("attach-btn");
const attachStrip = document.getElementById("attach-strip");

export function renderAttachStrip() {
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

export function bytesToBase64(bytes) {
  // Chunked charCode concat avoids pathological O(n²) string growth on
  // large buffers (audio recordings routinely hit ~1 MB).
  const CHUNK = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export async function fileToResizedB64(file, max = FRAME_SIZE, quality = 0.82) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bmp, 0, 0, w, h);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
  const buf = await blob.arrayBuffer();
  return bytesToBase64(new Uint8Array(buf));
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
