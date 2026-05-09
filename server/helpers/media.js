// ─────────────────────────────────────────────────────────────
//  helpers/media.js  v1
//
//  Responsibility:
//    1. Upload a raw audio buffer to the WhatsApp Cloud API
//       media endpoint → returns a media_id
//    2. Send that media_id as a WhatsApp "audio" message
//       (rendered as a voice note in the chat)
//
//  WhatsApp media upload flow:
//    POST /{phone-number-id}/media
//      multipart/form-data { file: <buffer>, type: "audio/mpeg", messaging_product: "whatsapp" }
//    → { id: "<media_id>" }
//
//    POST /{phone-number-id}/messages
//      { type: "audio", audio: { id: "<media_id>" } }
//
//  Supported audio formats for voice notes (WhatsApp):
//    audio/mpeg (.mp3), audio/ogg (.ogg), audio/aac (.aac)
//    We use audio/mpeg (MP3) from TTS output.
//
//  Environment variables required:
//    WHATSAPP_ACCESS_TOKEN
//    WHATSAPP_PHONE_NUMBER_ID
//
//  Returns null on any failure — never throws. Callers fall back
//  to text-only delivery.
// ─────────────────────────────────────────────────────────────
const fetch   = require("node-fetch");
const FormData = require("form-data");

const WA_API_BASE     = "https://graph.facebook.com/v18.0";
const TIMEOUT_MS      = 30_000;
const MAX_UPLOAD_RETRIES = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────
//  Step 1 — Upload audio buffer → WhatsApp media ID
// ─────────────────────────────────────────────────────────────

/**
 * Upload an audio buffer to WhatsApp's media endpoint.
 *
 * @param {Buffer} audioBuffer   — Raw audio bytes (MP3 / OGG / AAC)
 * @param {string} contentType   — MIME type e.g. "audio/mpeg"
 * @param {string} filename      — Suggested filename e.g. "reply.mp3"
 * @returns {string|null}        — WhatsApp media_id, or null on failure
 */
async function uploadAudioToWhatsApp(audioBuffer, contentType = "audio/mpeg", filename = "reply.mp3") {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token         = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!phoneNumberId || !token) {
    console.error("[Media] Missing WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN");
    return null;
  }

  const url = `${WA_API_BASE}/${phoneNumberId}/media`;

  for (let attempt = 1; attempt <= MAX_UPLOAD_RETRIES + 1; attempt++) {
    try {
      // Build multipart form — WhatsApp requires this exact shape
      const form = new FormData();
      form.append("messaging_product", "whatsapp");
      form.append("type", contentType);
      form.append("file", audioBuffer, {
        filename,
        contentType,
        knownLength: audioBuffer.byteLength,
      });

      console.log(
        `[Media] ⬆️  Uploading ${(audioBuffer.byteLength / 1024).toFixed(1)} KB` +
        ` ${contentType} (attempt ${attempt})…`
      );

      const res = await fetch(url, {
        method:  "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          ...form.getHeaders(),
        },
        body:    form,
        timeout: TIMEOUT_MS,
      });

      const data = await res.json();

      if (!res.ok) {
        const errMsg = data?.error?.message || `HTTP ${res.status}`;
        if (res.status === 401 || res.status === 403) {
          console.error(`[Media] Auth error: ${errMsg}`);
          return null;
        }
        throw new Error(errMsg);
      }

      if (!data?.id) {
        throw new Error(`No media ID in response: ${JSON.stringify(data)}`);
      }

      console.log(`[Media] ✅ Uploaded — media_id: ${data.id}`);
      return data.id;

    } catch (err) {
      console.error(
        `[Media] ❌ Upload attempt ${attempt}/${MAX_UPLOAD_RETRIES + 1} failed: ${err.message}`
      );
      if (attempt <= MAX_UPLOAD_RETRIES) await sleep(1500 * attempt);
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────
//  Step 2 — Send media_id as a WhatsApp audio (voice note) message
// ─────────────────────────────────────────────────────────────

/**
 * Send a previously uploaded media item as a WhatsApp audio message.
 * Recipients see it as a playable voice note.
 *
 * @param {string} recipientPhone  — e.g. "923001234567"
 * @param {string} mediaId         — Returned by uploadAudioToWhatsApp()
 * @returns {object|null}          — WhatsApp API response, or null on failure
 */
async function sendAudioMessage(recipientPhone, mediaId) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token         = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!phoneNumberId || !token) {
    console.error("[Media] Missing credentials — cannot send audio message.");
    return null;
  }

  const url = `${WA_API_BASE}/${phoneNumberId}/messages`;

  const body = {
    messaging_product: "whatsapp",
    recipient_type:    "individual",
    to:                recipientPhone,
    type:              "audio",
    audio: { id: mediaId },
  };

  try {
    const res = await fetch(url, {
      method:  "POST",
      headers: {
        Authorization:  `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body:    JSON.stringify(body),
      timeout: TIMEOUT_MS,
    });

    const data = await res.json();

    if (!res.ok) {
      const errMsg = data?.error?.message || `HTTP ${res.status}`;
      console.error(`[Media] ❌ sendAudioMessage failed: ${errMsg}`);
      return null;
    }

    console.log(`[Media] ✅ Audio message sent to ${recipientPhone}`);
    return data;

  } catch (err) {
    console.error(`[Media] ❌ sendAudioMessage network error: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
//  Convenience — upload + send in one call
// ─────────────────────────────────────────────────────────────

/**
 * Upload an audio buffer and immediately send it as a voice note.
 * Returns the media_id on success, null on failure.
 * Text fallback is the caller's responsibility.
 *
 * @param {string} recipientPhone
 * @param {Buffer} audioBuffer
 * @param {string} contentType     — default "audio/mpeg"
 * @returns {string|null}          — media_id if sent, null if failed
 */
async function uploadAndSendAudio(recipientPhone, audioBuffer, contentType = "audio/mpeg") {
  const mediaId = await uploadAudioToWhatsApp(audioBuffer, contentType);
  if (!mediaId) {
    console.warn("[Media] Upload failed — skipping audio send.");
    return null;
  }

  const result = await sendAudioMessage(recipientPhone, mediaId);
  if (!result) {
    console.warn("[Media] Send failed after successful upload — media_id:", mediaId);
    return null;
  }

  return mediaId;
}

module.exports = {
  uploadAudioToWhatsApp,
  sendAudioMessage,
  uploadAndSendAudio,
};
