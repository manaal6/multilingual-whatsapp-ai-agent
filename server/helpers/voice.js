// ─────────────────────────────────────────────────────────────
//  helpers/voice.js  v2
//
//  Changes over v1:
//  • processVoiceNote()   — end-to-end pipeline:
//      download → transcribe → TTS reply → upload → send voice note
//  • addAiVoiceReply()    — store AI voice reply URL in session
//  • Imports transcribe.js and tts.js and media.js
//  • All v1 exports are preserved (100% backwards-compatible)
//
//  v1 exports unchanged:
//    fetchMediaUrl, isCallbackRequest, getCallbackReply,
//    getVoiceNoteAck, buildVoiceNoteContext,
//    makeVoiceNoteEntry, serializeVoiceNotes
// ─────────────────────────────────────────────────────────────
const fetch = require("node-fetch");

// New v2 helpers — lazy-imported via functions to avoid circular deps
// (voice.js is imported by sessions.js which is imported by everything)
const { transcribeAudio }   = require("./transcribe");
const { generateTTSAudio }  = require("./tts");
const { uploadAndSendAudio } = require("./media");

// WhatsApp Graph API base (must match whatsapp.js)
const WA_API_BASE = "https://graph.facebook.com/v18.0";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────
//  [v1 unchanged] 1. Fetch media URL from WhatsApp Cloud API
// ─────────────────────────────────────────────────────────────

/**
 * Given a WhatsApp media ID, call the Graph API to get the
 * temporary CDN URL where the file can be downloaded.
 *
 * @param {string} mediaId
 * @returns {string|null}
 */
async function fetchMediaUrl(mediaId) {
  if (!mediaId) return null;

  const url   = `${WA_API_BASE}/${mediaId}`;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!token) {
    console.error("[Voice] WHATSAPP_ACCESS_TOKEN not set — cannot fetch media URL.");
    return null;
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10000,
      });

      if (!res.ok) {
        const body = await res.text();
        console.warn(`[Voice] Media URL fetch failed (attempt ${attempt}): HTTP ${res.status} — ${body}`);
        if (res.status === 401 || res.status === 403) return null;
        await sleep(1000 * attempt);
        continue;
      }

      const data = await res.json();

      if (data.url) {
        console.log(`[Voice] ✅ Media URL fetched for ${mediaId}: ${data.url.slice(0, 60)}…`);
        return data.url;
      }

      console.warn("[Voice] Media API returned no URL:", JSON.stringify(data));
      return null;

    } catch (err) {
      console.error(`[Voice] Network error fetching media URL (attempt ${attempt}):`, err.message);
      await sleep(1000 * attempt);
    }
  }

  console.error(`[Voice] ❌ Could not fetch media URL for ${mediaId} after 3 attempts.`);
  return null;
}

// ─────────────────────────────────────────────────────────────
//  [v1 unchanged] 2. Callback / call-request detection
// ─────────────────────────────────────────────────────────────

const CALLBACK_PATTERNS = [
  /\bcall\s*me\b/i,
  /\bgive\s*me\s*a\s*call\b/i,
  /\bphone\s*call\b/i,
  /\bvoice\s*call\b/i,
  /\bcan\s*you\s*call\b/i,
  /\bplease\s*call\b/i,
  /\bcallback\b/i,
  /\bring\s*me\b/i,
  /\bcontact\s*me\b/i,
  /\bwhatsapp\s*call\b/i,
  /\baudio\s*call\b/i,
  /\bvideo\s*call\b/i,
];

function isCallbackRequest(text) {
  if (!text || typeof text !== "string") return false;
  return CALLBACK_PATTERNS.some((re) => re.test(text));
}

function getCallbackReply() {
  return (
    "I appreciate you reaching out! 😊 Unfortunately I can't initiate calls directly, " +
    "but you can send me a *voice note* right here and I'll make sure the right person " +
    "follows up with you as soon as possible. Just press and hold the microphone icon to record!"
  );
}

// ─────────────────────────────────────────────────────────────
//  [v1 unchanged] 3. Voice note acknowledgement helpers
// ─────────────────────────────────────────────────────────────

function getVoiceNoteAck() {
  return "Thanks, I got your voice note! 🎙️ I'll make sure the team reviews it. Could you also share your name so I can follow up with you?";
}

/**
 * Builds context string injected into AI conversation history
 * when a voice note arrives.
 */
function buildVoiceNoteContext(mediaId, mediaUrl, transcript = null) {
  const urlPart = mediaUrl
    ? `Media URL: ${mediaUrl}`
    : "Media URL could not be fetched (will be retried).";

  const transcriptPart = transcript
    ? `\nTranscript: "${transcript}"`
    : "\nNo transcription available.";

  return (
    `[Customer sent a voice note. ${urlPart} | Media ID: ${mediaId}.${transcriptPart} ` +
    `Acknowledge that you received their voice note warmly${transcript ? ", reference what they said," : ""} ` +
    `then continue collecting any missing lead fields (name, phone, service) naturally.]`
  );
}

// ─────────────────────────────────────────────────────────────
//  [v1 unchanged] 4. Utility — normalise a voice note entry
// ─────────────────────────────────────────────────────────────

function makeVoiceNoteEntry(mediaId, mediaUrl) {
  return {
    id:         mediaId,
    url:        mediaUrl || null,
    receivedAt: new Date().toISOString(),
  };
}

function serializeVoiceNotes(voiceNotes) {
  if (!Array.isArray(voiceNotes) || voiceNotes.length === 0) return "";
  return voiceNotes
    .map((n) => n.url || `[no-url:${n.id}]`)
    .join(" | ");
}

// ─────────────────────────────────────────────────────────────
//  [NEW v2] 5. AI voice reply storage helper
// ─────────────────────────────────────────────────────────────

/**
 * Append a WhatsApp media_id (or public URL if available) to the
 * session's ai_voice_replies array.  Called from processVoiceNote()
 * and also available for external callers.
 *
 * session.ai_voice_replies is initialised lazily here so it remains
 * backwards-compatible with sessions that pre-date v2.
 *
 * @param {object} session   — The live session object (NOT the phone key)
 * @param {string} mediaId   — WhatsApp uploaded media ID
 */
function addAiVoiceReply(session, mediaId) {
  if (!session) return;
  if (!Array.isArray(session.ai_voice_replies)) {
    session.ai_voice_replies = [];
  }
  session.ai_voice_replies.push({
    mediaId,
    sentAt: new Date().toISOString(),
  });
}

/**
 * Serialise ai_voice_replies for Google Sheets (media IDs only —
 * WhatsApp media IDs are not public URLs).
 *
 * @param {Array<{mediaId, sentAt}>} replies
 * @returns {string}
 */
function serializeAiVoiceReplies(replies) {
  if (!Array.isArray(replies) || replies.length === 0) return "";
  return replies.map((r) => `[media:${r.mediaId}]`).join(" | ");
}

// ─────────────────────────────────────────────────────────────
//  [NEW v2] 6. Full voice note processing pipeline
//
//  Called from webhook.js AFTER the existing addVoiceNote() +
//  immediate ack send. Runs asynchronously so the webhook 200
//  response is already sent.
//
//  Pipeline:
//    1. Transcribe audio (Deepgram)
//    2. Store transcript in session
//    3. Generate TTS audio from AI clean reply (Groq)
//    4. Upload + send audio voice note back to user (WhatsApp)
//    5. Store AI voice reply ref in session
//
//  Signature is intentionally decoupled from sessions.js to
//  avoid circular imports — the caller passes the live session
//  object and the cleanReply text directly.
// ─────────────────────────────────────────────────────────────

/**
 * Run the full voice intelligence pipeline for one incoming voice note.
 *
 * @param {object} options
 * @param {string}      options.phone        — Sender phone number (for logging)
 * @param {string}      options.mediaId      — WhatsApp voice note media ID
 * @param {string|null} options.cdnUrl       — Resolved CDN download URL
 * @param {object}      options.session      — Live session object from sessions.js
 * @param {string}      options.cleanReply   — AI text reply (already sent as text)
 *
 * @returns {Promise<{ transcript: string|null, audioSent: boolean }>}
 */
async function processVoiceNote({ phone, mediaId, cdnUrl, session, cleanReply }) {
  let transcript = null;
  let audioSent  = false;

  // ── 1. Transcribe ─────────────────────────────────────────
  if (cdnUrl) {
    transcript = await transcribeAudio(cdnUrl);
  } else {
    console.warn(`[Voice] No CDN URL for ${mediaId} — skipping transcription.`);
  }

  // ── 2. Store transcript in session ────────────────────────
  if (transcript) {
    if (!Array.isArray(session.voice_transcriptions)) {
      session.voice_transcriptions = [];
    }
    session.voice_transcriptions.push(transcript);
    console.log(`[Voice] 📝 Transcript stored for ${phone}: "${transcript.slice(0, 60)}…"`);
  }

  // ── 3. Generate TTS audio from the AI reply ───────────────
  if (cleanReply && cleanReply.trim()) {
    const ttsResult = await generateTTSAudio(cleanReply);

    if (ttsResult) {
      // ── 4. Upload + send as WhatsApp voice note ───────────
      const sentMediaId = await uploadAndSendAudio(
        phone,
        ttsResult.buffer,
        ttsResult.contentType
      );

      if (sentMediaId) {
        // ── 5. Store AI voice reply reference ────────────────
        addAiVoiceReply(session, sentMediaId);
        audioSent = true;
        console.log(`[Voice] ✅ AI voice note sent to ${phone} — media_id: ${sentMediaId}`);
      } else {
        console.warn(`[Voice] TTS generated but WhatsApp send failed for ${phone}.`);
      }
    } else {
      console.warn(`[Voice] TTS generation failed for ${phone} — text reply was already sent.`);
    }
  }

  return { transcript, audioSent };
}

// ─────────────────────────────────────────────────────────────
//  Exports — ALL v1 names preserved + new v2 additions
// ─────────────────────────────────────────────────────────────
module.exports = {
  // v1 (unchanged)
  fetchMediaUrl,
  isCallbackRequest,
  getCallbackReply,
  getVoiceNoteAck,
  buildVoiceNoteContext,   // signature extended: accepts optional transcript param
  makeVoiceNoteEntry,
  serializeVoiceNotes,

  // v2 (new)
  processVoiceNote,
  addAiVoiceReply,
  serializeAiVoiceReplies,
};
