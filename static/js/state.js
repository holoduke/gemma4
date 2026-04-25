/* state.js
 * Cross-module mutable state. Kept here (instead of inside a feature
 * module) so no module has to import from a feature to read a toggle.
 * ES-module `export let` gives every importer a live binding, so
 * `toggles.tools = true` in ui.js is observable in chat.js immediately. */

// Streaming chat history sent to the model. Mutated by chat.js (push
// user/assistant/tool turns) and trimmed in place before each stream.
export const history = [];

// Attachments queued for the next user turn (base64 JPEG strings).
export const pending = { images: [] };

// Generation parameters.
export const CHAT_MAX_TOKENS = 131072;
export const HISTORY_MAX_MESSAGES = 40;

// Resolution presets for camera captures. Three independent values so
// the vision model can run at 480 while segmentation runs at 320.
export const RES_OPTIONS = [160, 192, 224, 256, 288, 320, 384, 480, 640, 768];
export const RES_DEFAULTS = { vision: 480, detect: 480, segment: 320 };

const _legacy = parseInt(localStorage.getItem("chatlm.resolution") || "0", 10);
export const RES = {
  vision:  parseInt(localStorage.getItem("chatlm.res.vision")  || (_legacy || RES_DEFAULTS.vision),  10),
  detect:  parseInt(localStorage.getItem("chatlm.res.detect")  || (_legacy || RES_DEFAULTS.detect),  10),
  segment: parseInt(localStorage.getItem("chatlm.res.segment") || (_legacy || RES_DEFAULTS.segment), 10),
};

// Default capture resolution for paths that don't pick a per-pipeline
// value yet (inpaint, img2img). Mutable — setter updates callers via
// ES-module live binding.
export let FRAME_SIZE = RES.vision;
export function setFrameSize(n) { FRAME_SIZE = n; }

// Toggle flags — objects so they can be mutated without reassigning the
// import binding. Each UI toggle writes here AND localStorage.
export const toggles = {
  think: localStorage.getItem("chatlm.think") === "1",
  tools: localStorage.getItem("chatlm.tools") === "1",
  autoApprove: localStorage.getItem("chatlm.autoApprove") === "1",
};

// LocalStorage keys for the model-selection dropdowns.
export const STORAGE_KEYS = {
  emma:      "chatlm.model.emma",
  scan:      "chatlm.model.scan",
  detector:  "chatlm.model.detector",
  segmenter: "chatlm.model.segmenter",
  inpaint:   "chatlm.model.inpaint",
  txt2img:   "chatlm.model.txt2img",
  interval:  "chatlm.interval",
  session:   "chatlm.session.active",
};
