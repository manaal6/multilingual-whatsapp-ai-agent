// ─────────────────────────────────────────────────────────────
//  helpers/whatsapp.js — WhatsApp Cloud API sender utility
// ─────────────────────────────────────────────────────────────
const fetch = require("node-fetch");

const WHATSAPP_API_URL = "https://graph.facebook.com/v18.0";
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

const MAX_SEND_RETRIES = 3;
const SEND_RETRY_MS   = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Send a plain text message to a WhatsApp number.
 * Retries up to MAX_SEND_RETRIES times on network/server errors.
 * @param {string} to   - Recipient phone number (e.g. "923001234567")
 * @param {string} text - Message body
 */
async function sendTextMessage(to, text) {
  const url = `${WHATSAPP_API_URL}/${PHONE_NUMBER_ID}/messages`;

  const body = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { body: text },
  };

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_SEND_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        timeout: 10000,
      });

      const data = await response.json();

      if (!response.ok) {
        lastError = data?.error?.message || `HTTP ${response.status}`;
        console.error(`[WhatsApp] Send error (attempt ${attempt}):`, lastError);
        // Auth errors won't be fixed by retrying
        if (response.status === 401 || response.status === 403) break;
        await sleep(SEND_RETRY_MS * attempt);
        continue;
      }

      console.log(`[WhatsApp] ✅ Message sent to ${to}`);
      return data;

    } catch (err) {
      lastError = err.message;
      console.error(`[WhatsApp] Network error (attempt ${attempt}/${MAX_SEND_RETRIES}):`, err.message);
      await sleep(SEND_RETRY_MS * attempt);
    }
  }

  console.error(`[WhatsApp] ❌ Failed to send message to ${to} after ${MAX_SEND_RETRIES} attempts:`, lastError);
  return null;
}

/**
 * Mark an incoming message as "read" (shows blue ticks).
 * @param {string} messageId - The message ID from the webhook payload
 */
async function markAsRead(messageId) {
  const url = `${WHATSAPP_API_URL}/${PHONE_NUMBER_ID}/messages`;

  const body = {
    messaging_product: "whatsapp",
    status: "read",
    message_id: messageId,
  };

  try {
    await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error("[WhatsApp] markAsRead error:", err.message);
  }
}

/**
 * Extract the text content from a WhatsApp webhook message object.
 * Handles: text, emoji, and voice note (returns placeholder for audio).
 * @param {object} message - Single message object from webhook
 * @returns {string}
 */
function extractMessageText(message) {
  if (message.type === "text") {
    return message.text?.body || "";
  }
  if (message.type === "audio") {
    // Voice notes — we return a placeholder; transcription requires paid STT
    return "[Voice message received — please type your message]";
  }
  if (message.type === "sticker") {
    return "[Sticker received]";
  }
  if (message.type === "image") {
    return "[Image received — please describe what you need in text]";
  }
  return message?.text?.body || `[${message.type} message received]`;
}

module.exports = { sendTextMessage, markAsRead, extractMessageText };
