/* tools.js
 * Tool definitions surfaced to the LLM, approval modals, per-tool
 * handlers, and the dispatcher. Adding a new tool = add a handler and
 * register it in TOOL_HANDLERS (no if/else editing required). */

import { scrollBottom, setStatus } from "./core.js";
import { history, toggles } from "./state.js";
import { addMessage, renderToolResult, renderToolMeta } from "./messages.js";
import { paintImage } from "./txt2img.js";
import { Mcp } from "./mcp.js";
import { Sessions } from "./sessions.js";

// Push a tool-response entry into both the live chat history (fed to
// the LLM on the next turn) and the session DB (fed to history on
// replay after a refresh). Keeps the two in sync so refresh ≡ no-op.
function recordToolResponse(toolName, content, extraMeta = null) {
  history.push({ role: "tool", content, tool_name: toolName });
  const meta = { tool_name: toolName, ...(extraMeta || {}) };
  Sessions.persist("tool", content, meta);
}

export const SHELL_TOOL = {
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
        command: { type: "string", description: "The shell command to run. One line. Quote paths containing spaces." },
      },
      required: ["command"],
    },
  },
};

export const IMAGE_TOOL = {
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
        prompt: { type: "string", description: "Rich description of the image to create. Include subject, style, mood, composition." },
        negative_prompt: { type: "string", description: "Optional: things to avoid in the image (ignored for FLUX)." },
      },
      required: ["prompt"],
    },
  },
};

// Backend-dispatched fire-and-render tools. `generate_image` deliberately
// lives in its own handler below because it needs progress streaming +
// session binding; this map is only for tools whose UI is trivial.
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

// ---------- approval modals ----------

function approveCommand(toolCall, container) {
  return new Promise((resolve) => {
    const args = toolCall.function?.arguments || {};
    const initialCmd = String(args.command ?? "");
    const card = document.createElement("div");
    card.className = "tool-call";
    const headLabel = toggles.autoApprove ? "// TOOL · RUN_SHELL · AUTO" : "// TOOL · RUN_SHELL";
    card.innerHTML = `
      <div class="tool-call-head">${headLabel}</div>
      <code class="tool-call-cmd" contenteditable="${toggles.autoApprove ? "false" : "true"}" spellcheck="false"></code>
      <div class="tool-call-actions"></div>`;
    const cmdEl = card.querySelector(".tool-call-cmd");
    cmdEl.textContent = initialCmd;
    container.appendChild(card);
    scrollBottom();
    if (toggles.autoApprove) {
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

function approveImagePrompt(args, container) {
  return new Promise((resolve) => {
    const initialPrompt = String(args.prompt ?? "");
    const card = document.createElement("div");
    card.className = "tool-call tool-call-image";
    const headLabel = toggles.autoApprove ? "// TOOL · GENERATE_IMAGE · AUTO" : "// TOOL · GENERATE_IMAGE";
    card.innerHTML = `
      <div class="tool-call-head">${headLabel}</div>
      <div class="tool-call-cmd" contenteditable="${toggles.autoApprove ? "false" : "true"}" spellcheck="false"></div>
      <div class="tool-call-actions"></div>`;
    const promptEl = card.querySelector(".tool-call-cmd");
    promptEl.textContent = initialPrompt;
    container.appendChild(card);
    scrollBottom();
    if (toggles.autoApprove) {
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

function approveMcpCall(toolName, args, container) {
  return new Promise((resolve) => {
    const initialJson = JSON.stringify(args, null, 2);
    const card = document.createElement("div");
    card.className = "tool-call";
    const headLabel = toggles.autoApprove ? `${toolName} · AUTO` : toolName;
    card.innerHTML = `
      <div class="tool-call-head">// MCP · ${headLabel}</div>
      <code class="tool-call-cmd" contenteditable="${toggles.autoApprove ? "false" : "true"}" spellcheck="false"></code>
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
    if (toggles.autoApprove) {
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

// ---------- tool-call handlers ----------
// Each handler owns its approval card, execution, UI rendering, and
// pushes exactly ONE `role:"tool"` entry into history — so the next
// stream turn sees a response for every tool it requested.

async function handleRunShell(tc, container) {
  setStatus("busy", "LINK // AWAITING APPROVAL");
  const decision = await approveCommand(tc, container);
  if (decision.decision === "deny") {
    renderToolMeta(decision.card, "denied by user");
    recordToolResponse("run_shell", "[user denied execution]");
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
    recordToolResponse(
      "run_shell",
      `$ ${decision.command}\n[exit ${result.exit_code}]\n${out}`,
      { command: decision.command, exit_code: result.exit_code },
    );
  } catch (err) {
    renderToolResult(decision.card, `[ERR] ${err.message}`, true);
    recordToolResponse("run_shell", `[exec failed] ${err.message}`);
  }
}

async function handleGenerateImage(tc, container) {
  setStatus("busy", "LINK // AWAITING APPROVAL");
  const args = tc.function?.arguments || {};
  const decision = await approveImagePrompt(args, container);
  if (decision.decision === "deny") {
    renderToolMeta(decision.card, "denied by user");
    recordToolResponse("generate_image", "[user denied image generation]");
    return;
  }
  // Replace the approval card with a proper image card; keeps the
  // original card's position in the log but loses its chrome.
  decision.card.remove();
  const { result } = await paintImage({ prompt: decision.prompt, parent: container });
  if (result) {
    recordToolResponse(
      "generate_image",
      `[image generated: ${result.width}x${result.height} via ${result.preset}]\n` +
        `path: ${result.path}\n` +
        `url:  ${result.image_url}\n` +
        `If the user asks to save/copy/move it, use run_shell with cp/mv on the path.`,
      { image_url: result.image_url, path: result.path, prompt: decision.prompt },
    );
  } else {
    recordToolResponse("generate_image", "[image generation failed]");
  }
}

async function handleMcpTool(tc, container) {
  const fn = tc.function?.name;
  const args = tc.function?.arguments || {};
  setStatus("busy", "LINK // AWAITING APPROVAL");
  const decision = await approveMcpCall(fn, args, container);
  if (decision.decision === "deny") {
    renderToolMeta(decision.card, "denied by user");
    recordToolResponse(fn, `[user denied ${fn}]`);
    return;
  }
  setStatus("busy", `LINK // ${fn.toUpperCase()}`);
  try {
    const t0 = performance.now();
    const result = await Mcp.call(fn, decision.args);
    const latencyMs = Math.round(performance.now() - t0);
    const display = result.text || "(no text; structured-only response)";
    renderToolResult(decision.card, display, !!result.is_error, { asMarkdown: true });
    renderToolMeta(
      decision.card,
      `${result.server} · ${result.tool}${result.is_error ? " · ERROR" : ""} · ${latencyMs} ms`,
    );
    // Prefer structured JSON for the tool response back to the LLM —
    // it parses reliably, where free text can drift. Also persist the
    // raw text so session replay can re-render the nice markdown card.
    const payload = result.structured ? JSON.stringify(result.structured) : (result.text || "");
    recordToolResponse(fn, payload, {
      text: result.text,
      structured: result.structured,
      server: result.server,
      is_mcp: true,
    });
  } catch (err) {
    renderToolResult(decision.card, `[ERR] ${err.message}`, true);
    recordToolResponse(fn, `[mcp call failed] ${err.message}`);
  }
}

const TOOL_HANDLERS = {
  run_shell: handleRunShell,
  generate_image: handleGenerateImage,
};

export async function dispatchToolCall(tc, container) {
  const fn = tc.function?.name;
  // MCP tools are prefixed mcp_<server>_<tool>; route them uniformly
  // through handleMcpTool regardless of which server they belong to.
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
