// ─────────────────────────────────────────────────────────────
//  helpers/sessions.js  v5
//
//  Changes over v4:
//  • Session shape adds detected_language (default "English")
//  • setDetectedLanguage() — called once per session when first
//    language is detected; never overwritten after that so the
//    AI stays consistent even if the user switches language
//  • getSessionMeta() now includes detected_language
//  • All v4 exports unchanged
// ─────────────────────────────────────────────────────────────
const { saveIncompleatLead } = require("./sheets");
const { makeVoiceNoteEntry } = require("./voice");

const sessions = new Map();

const SESSION_TTL_MS   = 30 * 60 * 1000;
const CLEANUP_INTERVAL =  5 * 60 * 1000;

function getSession(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, {
      messages:             [],
      leadCaptured:         false,
      lastActive:           Date.now(),
      callback_requested:   false,
      detected_language:    "English",   // v5 NEW
      partial: {
        name:         null,
        phone:        null,
        service:      null,
        last_message: null,
      },
      voice_notes:          [],
      voice_transcriptions: [],
      ai_voice_replies:     [],
    });
  }
  const session = sessions.get(phone);
  session.lastActive = Date.now();
  return session;
}

function getSessionMeta(phone) {
  const session = getSession(phone);
  return {
    voice_notes:          session.voice_notes,
    callback_requested:   session.callback_requested,
    transcription_count:  session.voice_transcriptions.length,
    detected_language:    session.detected_language,   // v5 NEW
  };
}

function appendMessage(phone, role, content) {
  const session = getSession(phone);
  session.messages.push({ role, content });
  if (session.messages.length > 40) session.messages = session.messages.slice(-40);
  if (role === "user") session.partial.last_message = content;
}

function updatePartialLead(phone, fields) {
  const session = getSession(phone);
  for (const [key, value] of Object.entries(fields)) {
    if (value && !session.partial[key]) {
      session.partial[key] = value;
      console.log(`[Sessions] 📝 ${phone} -> partial.${key} = "${value}"`);
    }
  }
}

function addVoiceNote(phone, mediaId, mediaUrl) {
  const session = getSession(phone);
  const alreadyStored = session.voice_notes.some((n) => n.id === mediaId);
  if (!alreadyStored) {
    session.voice_notes.push(makeVoiceNoteEntry(mediaId, mediaUrl || null));
    console.log(`[Sessions] 🎙️  Voice note stored for ${phone}: ${mediaUrl || mediaId}`);
  }
}

function setCallbackRequested(phone) {
  const session = getSession(phone);
  if (!session.callback_requested) {
    session.callback_requested = true;
    console.log(`[Sessions] 📞 Callback request flagged for ${phone}`);
  }
}

// Deepgram/Whisper language code → display name used in system prompt + TTS
const DEEPGRAM_LANG_MAP = {
ur: "Arabic/Urdu",
ar: "Arabic/Urdu",
hi: "Arabic/Urdu",  // Deepgram misclassifies Urdu as "hi" — treat hi as Urdu/Arabic
  zh: "Chinese",
  ja: "Japanese",
  ko: "Korean",
  ru: "Russian",
  es: "Spanish",
  fr: "French",
  de: "German",
  en: "English",
};

/**
 * Set / update the detected language for this session.
 * If deepgramCode is provided it takes priority over script-based detection.
 * Mid-conversation English detections do NOT overwrite a known non-English
 * language (e.g. user shares phone number in English — stay in Urdu).
 *
 * @param {string} phone
 * @param {string} language        — from detectLanguage() fallback
 * @param {string} [deepgramCode]  — raw code from Deepgram/Whisper e.g. "ur"
 */
function setDetectedLanguage(phone, language, deepgramCode = null) {
  const session = getSession(phone);

  const resolvedLanguage = deepgramCode
    ? (DEEPGRAM_LANG_MAP[deepgramCode] || language)
    : language;

  const current = session.detected_language;

if (resolvedLanguage === "English" && current !== "English" && deepgramCode === null) {
    console.log(`[Sessions] 🌐 Kept ${current} — ignored mid-convo English detection for ${phone}`);
    return;
  }

  if (resolvedLanguage !== current) {
    session.detected_language = resolvedLanguage;
    console.log(`[Sessions] 🌐 Language updated for ${phone}: ${current} → ${resolvedLanguage}`);
  }
}

function markLeadCaptured(phone) {
  getSession(phone).leadCaptured = true;
}

function resetSession(phone) {
  sessions.delete(phone);
  console.log(`[Sessions] 🔄 Session reset for ${phone}`);
}

// ── TTL cleanup ───────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [phone, session] of sessions.entries()) {
    if (now - session.lastActive > SESSION_TTL_MS) {
      if (!session.leadCaptured) {
        const hasData =
          session.partial.name    ||
          session.partial.service ||
          session.voice_notes.length > 0;

        if (hasData) {
          saveIncompleatLead({
            ...session.partial,
            phone:                session.partial.phone || phone,
            voice_notes:          session.voice_notes,
            voice_transcriptions: session.voice_transcriptions,
            ai_voice_replies:     session.ai_voice_replies,
            callback_requested:   session.callback_requested,
          });
        }
      }
      sessions.delete(phone);
      console.log(`[Sessions] 🧹 Evicted stale session: ${phone}`);
    }
  }
}, CLEANUP_INTERVAL);

module.exports = {
  getSession,
  getSessionMeta,
  appendMessage,
  updatePartialLead,
  addVoiceNote,
  setCallbackRequested,
  setDetectedLanguage,    // v5 NEW export
  markLeadCaptured,
  resetSession,
};