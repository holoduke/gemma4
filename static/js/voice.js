/* voice.js
 * Microphone (Whisper STT + optional live translation), voice cloning
 * (F5-TTS reference-sample capture), and the bot-message SPEAK button
 * that routes to Kokoro TTS OR the cloned voice. */

import { inputEl, setStat } from "./core.js";
import { addMessage } from "./messages.js";
import { appendFeed } from "./camera.js";
import { autosize } from "./ui.js";
import { bytesToBase64 } from "./attach.js";

// Populated by the 🎭 clone button. When set, SPEAK uses F5-TTS voice cloning.
export const voiceClone = { ref_audio: null, ref_text: null };

// ---------- Mic button (click-to-toggle: Whisper STT or live translate) ----------
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
      const b64 = bytesToBase64(new Uint8Array(buf));
      micBtn.classList.remove("recording");
      micBtn.textContent = "⋯";
      const langSel = document.getElementById("translate-lang");
      const targetLang = langSel ? langSel.value : "";
      try {
        if (targetLang) {
          // Live translation pipeline: STT → Gemma translate → Kokoro TTS
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

// Click-to-toggle (not hold-to-record — awaiting getUserMedia can outlast
// a quick click and confuse the state machine).
micBtn.addEventListener("click", () => {
  if (mediaRecorder && mediaRecorder.state === "recording") stopRecording();
  else startRecording();
});

// ---------- Voice clone (F5-TTS): hold to record 8-15s of reference audio ----------
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
      const b64 = bytesToBase64(new Uint8Array(buf));
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
    const holdStart = performance.now();
    const onUp = () => {
      cloneBtn.removeEventListener("mouseup", onUp);
      if (performance.now() - holdStart < 300 && cloneRecorder == null) {
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
    startCloneRecording();
  } else {
    startCloneRecording();
  }
});
cloneBtn.addEventListener("mouseleave", stopCloneRecording);
cloneBtn.addEventListener("touchstart", startCloneRecording, { passive: true });
cloneBtn.addEventListener("touchend", stopCloneRecording);

// ---------- Bot-message SPEAK button: Kokoro TTS or cloned voice ----------
let _speakAudio = null;
let _speakBtn = null;

export async function speakText(text, btn) {
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
