/* main.js — entry point.
 * Imports every module (so their side-effect wiring runs), then kicks
 * off boot: health ping, model dropdowns, sessions+MCP sidebars, mode
 * switcher, and the form submit handler. Order matters for side-effect
 * modules (e.g. `video.js` registers pipeline stops on load); keep the
 * import list in dependency order. */

import { logEl, formEl, inputEl } from "./core.js";
import { pending } from "./state.js";
import { addMessage } from "./messages.js";
import { Sessions } from "./sessions.js";
import { Mcp } from "./mcp.js";
import { send } from "./chat.js";
import { generateImageInline } from "./txt2img.js";
import { autosize, loadHealth, refreshModels, setMode } from "./ui.js";

// These modules only run for their side-effects (event listeners + DOM
// wiring). Importing without destructuring triggers evaluation.
import "./attach.js";
import "./voice.js";
import "./camera.js";
import "./video.js";
import "./tools.js";

// Form submit — the only entry point for user-typed messages. Slash
// command /image <prompt> routes to inline image generation; everything
// else is a chat turn.
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

loadHealth();
refreshModels();
// Boot sessions — suppress the welcome banner on pages that already
// have replayed history; only show it on a brand-new session.
Sessions.init().then(() => {
  if (logEl.children.length === 0) {
    addMessage("sys", "Neural link established. Gemma-4 online. Transmit query below.");
  }
});
Mcp.init();
setMode(localStorage.getItem("chatlm.mode") || "chat");
if (document.body.classList.contains("mode-chat")) inputEl.focus();
