// ─────────────────────────────────────────────────────────────
//  helpers/groq.js  v4
//
//  Changes over v3:
//  • buildSystemPrompt() now includes LANGUAGE instruction —
//    AI detects and mirrors the user's language automatically
//  • sessionMeta.detected_language passed in from sessions.js
//  • All v3 exports and signatures unchanged (drop-in replace)
// ─────────────────────────────────────────────────────────────
const fetch = require("node-fetch");
const { buildVoiceNoteContext } = require("./voice");

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL   = "llama-3.3-70b-versatile";

const MAX_RETRIES    = 3;
const RETRY_DELAY_MS = 1200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────
//  Language detection — lightweight, no external dependency
//  Detects script/language from the first meaningful message.
//  Returns a language tag string used in the system prompt.
// ─────────────────────────────────────────────────────────────

// Unicode range checks for common scripts
const SCRIPT_RANGES = {
  arabic:   /[\u0600-\u06FF\u0750-\u077F]/,
  urdu:     /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/,
  chinese:  /[\u4E00-\u9FFF\u3400-\u4DBF]/,
  japanese: /[\u3040-\u309F\u30A0-\u30FF]/,
  korean:   /[\uAC00-\uD7AF\u1100-\u11FF]/,
  hindi:    /[\u0900-\u097F]/,
  russian:  /[\u0400-\u04FF]/,
  spanish:  /\b(hola|gracias|cómo|quiero|necesito|buenos|precio|servicio)\b/i,
  french:   /\b(bonjour|merci|je|vous|nous|prix|service|besoin)\b/i,
  german:   /\b(hallo|danke|ich|sie|wir|preis|dienst|brauche)\b/i,
};

/**
 * Detect language from text. Returns a descriptor string for the prompt.
 * Urdu and Arabic share script — we treat them as "Arabic/Urdu" together
 * since both Orpheus Arabic TTS and llama-3.3 handle both well.
 *
 * @param {string} text
 * @returns {string} e.g. "Arabic/Urdu", "English", "Spanish", ...
 */
function detectLanguage(text) {
  if (!text || text.length < 3) return "English";

  if (SCRIPT_RANGES.arabic.test(text))  return "Arabic/Urdu";
  if (SCRIPT_RANGES.hindi.test(text))   return "Hindi";
  if (SCRIPT_RANGES.chinese.test(text)) return "Chinese";
  if (SCRIPT_RANGES.japanese.test(text))return "Japanese";
  if (SCRIPT_RANGES.korean.test(text))  return "Korean";
  if (SCRIPT_RANGES.russian.test(text)) return "Russian";
  if (SCRIPT_RANGES.spanish.test(text)) return "Spanish";
  if (SCRIPT_RANGES.french.test(text))  return "French";
  if (SCRIPT_RANGES.german.test(text))  return "German";

  return "English";
}

// ─────────────────────────────────────────────────────────────
//  Dynamic system prompt
// ─────────────────────────────────────────────────────────────
function buildSystemPrompt(partialLead = {}, sessionMeta = {}) {
  // ── Lead field status ─────────────────────────────────────
  const known = {
    name:    partialLead.name    || null,
    phone:   partialLead.phone   || null,
    service: partialLead.service || null,
  };

  const missing = Object.entries(known)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  const knownStr = Object.entries(known)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: "${v}"`)
    .join(", ");

  const leadStatusBlock =
    missing.length === 0
      ? "✅ All fields collected — confirm and close the lead."
      : `Known: ${knownStr || "nothing yet"}. Still need: ${missing.join(", ")}.`;

  // ── Voice note context ────────────────────────────────────
  const voiceCount = Array.isArray(sessionMeta.voice_notes)
    ? sessionMeta.voice_notes.length : 0;
  const voiceBlock = voiceCount > 0
    ? `The customer has sent ${voiceCount} voice note(s). Respond naturally to what they said.`
    : "";

  // ── Callback context ──────────────────────────────────────
  const callbackBlock = sessionMeta.callback_requested
    ? `The customer previously requested a phone call. You already explained that you can't initiate calls. Do NOT repeat that — just continue collecting lead fields.`
    : "";

  // ── Language instruction (v4 NEW) ─────────────────────────
  const lang = sessionMeta.detected_language || "English";
  const langBlock = lang === "English"
    ? `Respond in English.`
    : `IMPORTANT: The customer is communicating in ${lang}. You MUST reply entirely in ${lang}. Do not switch to English. The LEAD_CAPTURED marker must still be in English JSON format regardless of language.`;

  return `You are Priya, a warm and professional AI customer support agent replying over WhatsApp.

LANGUAGE: ${langBlock}

LEAD STATUS: ${leadStatusBlock}
${voiceBlock    ? `\nVOICE NOTES: ${voiceBlock}`   : ""}
${callbackBlock ? `\nCALLBACK: ${callbackBlock}`   : ""}

YOUR GOALS:
1. Greet new customers warmly on their first message only.
2. Collect the three lead fields — one at a time, conversationally:
   • name  (first name is fine)
   • phone (their preferred contact number; their WhatsApp number is a fallback)
   • service (what they need: consulting, pricing, booking, complaint, general inquiry, etc.)
3. Answer product/service questions briefly.
4. Once ALL three fields are confirmed, emit the LEAD_CAPTURED marker.

RULES:
- 1–3 short sentences per reply. Never a wall of text.
- Never ask for a field you already know.
- Never ask for name + phone + service in the same message.
- If the customer shares their phone number, acknowledge it naturally and move on.
- Max 1 emoji per reply, only when it genuinely fits.
- Angry customer → empathise first, then help.
- Prices/availability unknown → tell them in their language that the team will follow up.
- Voice note received → respond naturally to what they said, continue collecting missing fields.
- Callback requested → only explain once that you can't call; then guide to voice note.
- Always reply in the customer's language, not English, unless they write in English.

LEAD CAPTURE — when all three fields are confirmed, end your reply with this EXACTLY on its own line (always in English JSON, regardless of conversation language):
LEAD_CAPTURED:{"name":"<value>","phone":"<value>","service":"<value>"}

Only emit LEAD_CAPTURED once. Never emit it if any field is still unknown.`;
}

// ─────────────────────────────────────────────────────────────
//  Phone number extraction (unchanged)
// ─────────────────────────────────────────────────────────────
const PHONE_REGEX =
  /(?:\+?92[-\s]?|0)3[0-9]{2}[-\s]?[0-9]{7}|(?:\+?[1-9]\d{0,3}[-\s.]?)?\(?\d{2,4}\)?[-\s.]?\d{3,4}[-\s.]?\d{4}/g;

function extractPhoneFromText(text) {
  const matches = (text || "").match(PHONE_REGEX);
  if (!matches || matches.length === 0) return null;
  return matches[0].replace(/[\s\-.()]/g, "").trim();
}

// ─────────────────────────────────────────────────────────────
//  Core Groq API call — unchanged
// ─────────────────────────────────────────────────────────────
async function getAIReply(messages, partialLead = {}, sessionMeta = {}) {
  const payload = {
    model:      GROQ_MODEL,
    max_tokens: 300,
    temperature: 0.6,
    messages: [
      { role: "system", content: buildSystemPrompt(partialLead, sessionMeta) },
      ...messages,
    ],
  };

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(GROQ_API_URL, {
        method:  "POST",
        headers: {
          Authorization:  `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
        body:    JSON.stringify(payload),
        timeout: 15000,
      });

      const data = await response.json();

      if (!response.ok) {
        if (response.status === 429) {
          console.warn(`[Groq] Rate limited (attempt ${attempt}/${MAX_RETRIES})`);
          await sleep(RETRY_DELAY_MS * attempt * 2);
          continue;
        }
        lastError = data?.error?.message || `HTTP ${response.status}`;
        console.error(`[Groq] API error (attempt ${attempt}):`, lastError);
        if (response.status === 400 || response.status === 401) break;
        await sleep(RETRY_DELAY_MS * attempt);
        continue;
      }

      const reply = data.choices?.[0]?.message?.content;
      if (!reply) { lastError = "Empty response"; await sleep(RETRY_DELAY_MS); continue; }

      return reply;

    } catch (err) {
      lastError = err.message;
      console.error(`[Groq] Network error (attempt ${attempt}/${MAX_RETRIES}):`, err.message);
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }

  console.error("[Groq] All retries exhausted:", lastError);
  return "I'm having a small technical issue right now — please try again in a moment! 🙏";
}

// ─────────────────────────────────────────────────────────────
//  Lead marker parser (unchanged)
// ─────────────────────────────────────────────────────────────
function parseLeadFromReply(replyText) {
  const marker = "LEAD_CAPTURED:";
  const idx    = replyText.indexOf(marker);

  if (idx === -1) return { lead: null, cleanReply: replyText.trim() };

  const cleanReply = replyText.slice(0, idx).trim();
  const jsonStr    = replyText.slice(idx + marker.length).trim();

  try {
    const lead = JSON.parse(jsonStr);
    if (lead.phone) lead.phone = lead.phone.replace(/[\s\-.()]/g, "").trim();
    return { lead, cleanReply };
  } catch (err) {
    console.error("[Groq] Failed to parse LEAD_CAPTURED JSON:", jsonStr);
    return { lead: null, cleanReply };
  }
}

module.exports = {
  getAIReply,
  parseLeadFromReply,
  extractPhoneFromText,
  detectLanguage,          // exported so webhook.js can use it
  buildVoiceNoteContext,   // re-exported for backwards compat
};