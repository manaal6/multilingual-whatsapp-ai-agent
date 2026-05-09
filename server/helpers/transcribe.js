// ─────────────────────────────────────────────────────────────
//  helpers/transcribe.js  v2
//
//  Changes over v1:
//  • Deepgram uses detect_language=true instead of language=en
//    → correctly identifies Urdu (ur), Arabic (ar), Hindi (hi), etc.
//  • Returns { transcript, deepgramLangCode } instead of plain string
//    → webhook.js passes deepgramLangCode to setDetectedLanguage()
//    → sessions.js maps "ur" → "Arabic/Urdu" for correct TTS model
//  • Groq Whisper (whisper-large-v3-turbo) as automatic fallback
//    → handles short Urdu/Arabic clips that Deepgram returns empty for
//    → Whisper also returns detected_language for language mapping
//  • Audio downloaded ONCE, buffer reused for both engines
//
//  Environment variables required:
//    DEEPGRAM_API_KEY  — https://console.deepgram.com
//    GROQ_API_KEY      — already present for LLM; reused for Whisper
// ─────────────────────────────────────────────────────────────
const fetch    = require("node-fetch");
const FormData = require("form-data");

// ── Deepgram ──────────────────────────────────────────────────
const DEEPGRAM_URL =
  "https://api.deepgram.com/v1/listen" +
  "?model=nova-2" +
  "&detect_language=true" +   // auto-detect: ur, ar, hi, en, etc.
  "&smart_format=true" +
  "&punctuate=true" +
  "&utterances=false";

// ── Groq Whisper (fallback) ───────────────────────────────────
const GROQ_WHISPER_URL   = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_WHISPER_MODEL = "whisper-large-v3-turbo";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const TIMEOUT_MS      = 30_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────
//  Step 1 — Download audio from WhatsApp CDN
// ─────────────────────────────────────────────────────────────
async function _downloadAudio(cdnUrl) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!token) throw new Error("WHATSAPP_ACCESS_TOKEN not set");

  const res = await fetch(cdnUrl, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: TIMEOUT_MS,
  });

  if (!res.ok) throw new Error(`Audio download failed: HTTP ${res.status}`);

  const contentType = res.headers.get("content-type") || "audio/ogg";
  const buffer      = await res.buffer();

  if (buffer.byteLength > MAX_AUDIO_BYTES) {
    throw new Error(`Audio too large: ${(buffer.byteLength / 1_048_576).toFixed(1)} MB`);
  }

  console.log(
    `[Transcribe] ⬇️  Downloaded ${(buffer.byteLength / 1024).toFixed(1)} KB (${contentType}) from CDN`
  );

  return { buffer, contentType };
}

// ─────────────────────────────────────────────────────────────
//  Step 2a — Deepgram (primary)
//  Returns { transcript, confidence, deepgramLangCode } or throws
// ─────────────────────────────────────────────────────────────
async function _callDeepgram(buffer, contentType) {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) throw new Error("DEEPGRAM_API_KEY not set");

  const res = await fetch(DEEPGRAM_URL, {
    method:  "POST",
    headers: {
      Authorization:  `Token ${apiKey}`,
      "Content-Type": contentType,
    },
    body:    buffer,
    timeout: TIMEOUT_MS,
  });

  const data = await res.json();

  if (!res.ok) {
    const msg = data?.err_msg || data?.message || `HTTP ${res.status}`;
    throw new Error(`Deepgram error: ${msg}`);
  }

  const channel    = data?.results?.channels?.[0];
  const transcript = channel?.alternatives?.[0]?.transcript?.trim();

  if (!transcript) throw new Error("Deepgram returned empty transcript");

  const confidence       = channel?.alternatives?.[0]?.confidence ?? null;
  const deepgramLangCode = channel?.detected_language ?? null;

  console.log(`[Transcribe] 🌐 Deepgram detected language: ${deepgramLangCode || "unknown"}`);

  return { transcript, confidence, deepgramLangCode };
}

// ─────────────────────────────────────────────────────────────
//  Step 2b — Groq Whisper (fallback)
//  Used when Deepgram returns empty (common for short Urdu clips)
//  Returns { transcript, deepgramLangCode } or throws
// ─────────────────────────────────────────────────────────────
async function _callGroqWhisper(buffer, contentType) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY not set");

  const form = new FormData();
  form.append("file", buffer, { filename: "audio.ogg", contentType });
  form.append("model",           GROQ_WHISPER_MODEL);
  form.append("response_format", "verbose_json"); // includes language field

  const res = await fetch(GROQ_WHISPER_URL, {
    method:  "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...form.getHeaders(),
    },
    body:    form,
    timeout: TIMEOUT_MS,
  });

  const data = await res.json();

  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    throw new Error(`Groq Whisper error: ${msg}`);
  }

  const transcript = data?.text?.trim();
  if (!transcript) throw new Error("Groq Whisper returned empty transcript");

  // Whisper returns full language names e.g. "urdu", "english"
  // Map to short codes matching Deepgram for consistent language handling
  const WHISPER_LANG_MAP = {
    urdu:     "ur",
    arabic:   "ar",
    hindi:    "hi",
    english:  "en",
    chinese:  "zh",
    japanese: "ja",
    korean:   "ko",
    russian:  "ru",
    spanish:  "es",
    french:   "fr",
    german:   "de",
    thai:     "th",
  };

  const whisperLang      = (data?.language || "").toLowerCase();
  const deepgramLangCode = WHISPER_LANG_MAP[whisperLang] || whisperLang || null;

  console.log(
    `[Transcribe] 🌐 Whisper detected language: ${data?.language || "unknown"} → code: ${deepgramLangCode}`
  );

  return { transcript, deepgramLangCode };
}

// ─────────────────────────────────────────────────────────────
//  Public API
// ─────────────────────────────────────────────────────────────

/**
 * Transcribe a WhatsApp voice note.
 * Tries Deepgram first; falls back to Groq Whisper automatically.
 *
 * @param {string} cdnUrl   — Temporary download URL from fetchMediaUrl()
 * @param {number} retries  — Deepgram retries before Whisper fallback (default 1)
 * @returns {{ transcript: string, deepgramLangCode: string|null } | null}
 */
async function transcribeAudio(cdnUrl, retries = 1) {
  if (!cdnUrl) {
    console.warn("[Transcribe] No CDN URL — skipping.");
    return null;
  }
  if (!process.env.DEEPGRAM_API_KEY && !process.env.GROQ_API_KEY) {
    console.warn("[Transcribe] No API keys set — transcription disabled.");
    return null;
  }

  // Download once — buffer reused by both engines
  let buffer, contentType;
  try {
    ({ buffer, contentType } = await _downloadAudio(cdnUrl));
  } catch (err) {
    console.error(`[Transcribe] ❌ Download failed: ${err.message}`);
    return null;
  }

  // ── Try Deepgram ──────────────────────────────────────────
  if (process.env.DEEPGRAM_API_KEY) {
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      try {
        const { transcript, confidence, deepgramLangCode } =
          await _callDeepgram(buffer, contentType);

        console.log(
          `[Transcribe] ✅ Deepgram (confidence ${(confidence * 100).toFixed(0)}%): ` +
          `"${transcript.slice(0, 80)}${transcript.length > 80 ? "…" : ""}"`
        );
        return { transcript, deepgramLangCode };

      } catch (err) {
        console.warn(`[Transcribe] ⚠️  Deepgram attempt ${attempt}/${retries + 1}: ${err.message}`);
        if (attempt <= retries) await sleep(1000 * attempt);
      }
    }
    console.warn("[Transcribe] Deepgram exhausted — trying Groq Whisper fallback…");
  }

  // ── Fallback: Groq Whisper ────────────────────────────────
  if (process.env.GROQ_API_KEY) {
    try {
      const { transcript, deepgramLangCode } = await _callGroqWhisper(buffer, contentType);
      console.log(
        `[Transcribe] ✅ Whisper fallback: "${transcript.slice(0, 80)}${transcript.length > 80 ? "…" : ""}"`
      );
      return { transcript, deepgramLangCode };
    } catch (err) {
      console.error(`[Transcribe] ❌ Groq Whisper failed: ${err.message}`);
    }
  }

  console.error("[Transcribe] Both engines failed — returning null.");
  return null;
}

module.exports = { transcribeAudio };