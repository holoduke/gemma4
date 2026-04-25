/* chat.js
 * Streaming chat turn: builds the system preamble, opens the SSE stream
 * to /chat/stream, dedupes re-emitted tool calls, renders the final meta
 * line with token-rate + SPEAK button, and drives the tool-loop up to
 * MAX_TOOL_ROUNDS. `send()` is the single entry point for user turns. */

import { scrollBottom, setStatus, sendEl, inputEl } from "./core.js";
import { history, pending, toggles, CHAT_MAX_TOKENS, HISTORY_MAX_MESSAGES } from "./state.js";
import { addMessage } from "./messages.js";
import { SHELL_TOOL, IMAGE_TOOL, dispatchToolCall } from "./tools.js";
import { Sessions } from "./sessions.js";
import { speakText } from "./voice.js";
import { renderAttachStrip } from "./attach.js";
import { renderMarkdown } from "./markdown.js";

function trimHistoryInPlace() {
  if (history.length <= HISTORY_MAX_MESSAGES) return;
  const excess = history.length - HISTORY_MAX_MESSAGES;
  history.splice(0, excess);
}

/* System prompt — injected per-turn (NOT persisted into history) so
 * edits take effect on the next send and old replays stay clean. Base
 * preamble sets identity + tone; addendum kicks in only when TOOLS is
 * on so chat-only conversations don't waste context on tool plumbing. */
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
  5. **Preserve URLs, IDs, and prices verbatim** when the tool result contained them and the user might act on them (booking links, file paths, order IDs, amounts, dates). The tool output already rendered nicely on screen, so your summary can be short — but the concrete actionable bits (links, prices, IDs) must still appear in your summary as-is, formatted as markdown links \`[label](url)\` where applicable.
  6. If a tool fails, say what failed and either retry with a fixed command or ask the user a concrete question.

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
  const text = toggles.tools
    ? `${SYSTEM_PROMPT_BASE}\n\n${SYSTEM_PROMPT_TOOLS}`
    : SYSTEM_PROMPT_BASE;
  return { role: "system", content: text };
}

async function streamChatTurn(botBody) {
  trimHistoryInPlace();
  const payload = {
    messages: [buildSystemMessage(), ...history],
    stream: true,
    think: toggles.think,
    max_tokens: CHAT_MAX_TOKENS,
  };
  if (toggles.tools) payload.tools = [SHELL_TOOL, IMAGE_TOOL];
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
          thoughtBodyEl.innerHTML = renderMarkdown(thought);
          scrollBottom();
        }
        const delta = evt.message?.content ?? "";
        if (delta) {
          if (firstTokenAt === null) firstTokenAt = performance.now();
          full += delta;
          botBody.innerHTML = renderMarkdown(full);
          scrollBottom();
        }
        // Ollama streams tool-call chunks incrementally and often re-emits
        // the same tool_calls across events. Dedupe by a stable key so we
        // approve / execute each call exactly once.
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
  return { content: full, thought, toolCalls, finalEvt, botBody, startedAt, firstTokenAt };
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

const MAX_TOOL_ROUNDS = 6;

export async function send(text) {
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
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const botBody = addMessage("bot", "", { typing: true });
      // Persist a placeholder bot row BEFORE streaming so a mid-stream
      // refresh leaves a record (rather than just the user's question
      // with no answer). We patch it on stream completion or on error.
      const placeholder = await Sessions.persistAwait(
        "bot", "", { streaming: true },
      );
      const placeholderId = placeholder?.id ?? null;

      let turn;
      try {
        turn = await streamChatTurn(botBody);
      } catch (err) {
        botBody.classList.remove("cursor");
        botBody.textContent = `[ERR] ${err.message}`;
        setStatus("err", "LINK // ERROR");
        // Persist the failure so refresh shows the error, not a blank turn.
        if (placeholderId != null) {
          Sessions.update(placeholderId, `[ERR] ${err.message}`, { error: true });
        }
        return;
      }
      botBody.classList.remove("cursor");

      // Push the assistant message (with any tool calls) into history so
      // the next turn references it correctly.
      const asstMsg = { role: "assistant", content: turn.content };
      if (turn.toolCalls.length) asstMsg.tool_calls = turn.toolCalls;
      history.push(asstMsg);
      renderTurnMeta(botBody, turn);

      // Patch the placeholder with the final content + meta. Meta stashes
      // whatever session replay needs to reconstruct the LLM-visible
      // history + UI after a refresh:
      //   tool_calls  — so role:"tool" replies have an assistant to answer
      //   thinking    — the reasoning panel, replayed collapsed
      {
        const botMeta = {};
        if (turn.toolCalls.length) botMeta.tool_calls = turn.toolCalls;
        if (turn.thought) botMeta.thinking = turn.thought;
        const finalContent = turn.content || botBody.textContent || "";
        if (placeholderId != null) {
          Sessions.update(placeholderId, finalContent, Object.keys(botMeta).length ? botMeta : null);
        } else {
          // No active session id at start (rare race) — fall back to append.
          Sessions.persist("bot", finalContent, Object.keys(botMeta).length ? botMeta : null);
        }
      }

      if (!turn.toolCalls.length) {
        setStatus("ok", "LINK // READY");
        return;
      }

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
