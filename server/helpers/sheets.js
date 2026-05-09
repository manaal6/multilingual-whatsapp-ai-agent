// ─────────────────────────────────────────────────────────────
//  helpers/sheets.js  v4
//
//  Changes over v3:
//  • _buildLeadRow() now includes:
//      voice_transcriptions  — pipe-joined transcript strings
//      ai_voice_replies      — pipe-joined media ID refs
//  • serializeAiVoiceReplies() imported from voice.js
//  • All v3 exports and behaviour are 100% preserved
//  • Google Apps Script Code.gs now receives two extra fields —
//    add columns G (voice_transcriptions) and H (ai_voice_replies)
//    to your sheet if you want them stored; otherwise they are
//    silently ignored by the existing Apps Script handler.
// ─────────────────────────────────────────────────────────────
const fetch = require("node-fetch");
const { serializeVoiceNotes, serializeAiVoiceReplies } = require("./voice");

// ── In-memory stores ──────────────────────────────────────────
const leadsStore  = [];
const failedQueue = [];

const MAX_RETRIES   = 3;
const RETRY_BASE_MS = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────
//  Internal: single POST attempt to Apps Script
// ─────────────────────────────────────────────────────────────
async function _postToSheets(lead) {
  const webhookUrl = process.env.SHEETS_WEBHOOK_URL;

  if (!webhookUrl || webhookUrl.includes("YOUR_SCRIPT_ID")) {
    console.warn("[Sheets] ⚠️  SHEETS_WEBHOOK_URL not configured — skipping remote push.");
    return { ok: true, skipped: true };
  }

  const response = await fetch(webhookUrl, {
    method:   "POST",
    headers:  { "Content-Type": "application/json" },
    body:     JSON.stringify(lead),
    redirect: "follow",
    timeout:  12000,
  });

  const rawText = await response.text();

  let parsed = null;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    parsed = { status: response.ok ? "ok" : "error", raw: rawText.slice(0, 200) };
  }

  if (!response.ok || parsed?.status === "error") {
    throw new Error(
      `Sheets push failed: HTTP ${response.status} — ${parsed?.message || parsed?.raw || rawText.slice(0, 100)}`
    );
  }

  console.log("[Sheets] ✅ Remote push response:", parsed);
  return { ok: true, parsed };
}

// ─────────────────────────────────────────────────────────────
//  Internal: push with exponential-backoff retry
// ─────────────────────────────────────────────────────────────
async function _pushWithRetry(lead) {
  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await _postToSheets(lead);
      if (result.skipped) return;
      return;
    } catch (err) {
      lastErr = err.message;
      console.warn(`[Sheets] Push attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
      if (attempt < MAX_RETRIES) await sleep(RETRY_BASE_MS * attempt);
    }
  }

  console.error("[Sheets] ❌ All retries failed — queuing lead for later retry.");
  failedQueue.push({ lead, failedAt: new Date().toISOString() });
}

// ─────────────────────────────────────────────────────────────
//  Internal: retry queued failed pushes
// ─────────────────────────────────────────────────────────────
async function _drainFailedQueue() {
  if (failedQueue.length === 0) return;

  console.log(`[Sheets] 🔄 Draining ${failedQueue.length} queued push(es)…`);
  const toRetry = failedQueue.splice(0, failedQueue.length);

  for (const item of toRetry) {
    try {
      await _postToSheets(item.lead);
      console.log("[Sheets] ✅ Queued lead pushed:", item.lead.phone);
    } catch (err) {
      console.error("[Sheets] ❌ Queued lead still failing:", err.message);
      failedQueue.push(item);
    }
  }
}

// ─────────────────────────────────────────────────────────────
//  Internal: shape a raw lead object into the canonical row format
//
//  v4 additions (backwards-compatible):
//    voice_transcriptions  — array of strings from Deepgram
//    ai_voice_replies      — array of {mediaId, sentAt} objects
// ─────────────────────────────────────────────────────────────
function _buildLeadRow(lead, status = "complete") {
  // ── voice_notes (v3, unchanged) ───────────────────────────
  const voiceNotesStr = Array.isArray(lead.voice_notes)
    ? (typeof lead.voice_notes[0] === "object"
        ? serializeVoiceNotes(lead.voice_notes)
        : lead.voice_notes.join(" | "))
    : (lead.voice_notes || "");

  // ── voice_transcriptions (v4 NEW) ────────────────────────
  const transcriptionsStr = Array.isArray(lead.voice_transcriptions)
    ? lead.voice_transcriptions.join(" | ")
    : (lead.voice_transcriptions || "");

  // ── ai_voice_replies (v4 NEW) ────────────────────────────
  const aiVoiceRepliesStr = Array.isArray(lead.ai_voice_replies)
    ? (lead.ai_voice_replies.length > 0 && typeof lead.ai_voice_replies[0] === "object"
        ? serializeAiVoiceReplies(lead.ai_voice_replies)   // {mediaId, sentAt} objects
        : lead.ai_voice_replies.join(" | "))                // plain strings (legacy)
    : (lead.ai_voice_replies || "");

  return {
    // ── v3 fields (all preserved) ─────────────────────────
    name:              lead.name              || "Unknown",
    phone:             lead.phone             || "Unknown",
    service:           lead.service           || "General Inquiry",
    last_message:      lead.last_message      || "",
    voice_notes:       voiceNotesStr,
    has_voice_notes:   voiceNotesStr.length > 0 ? "Yes" : "No",
    callback_request:  lead.callback_requested ? "Yes" : "No",
    timestamp:         lead.timestamp         || new Date().toISOString(),
    status,

    // ── v4 fields (new, additive) ─────────────────────────
    voice_transcriptions: transcriptionsStr,
    ai_voice_replies:     aiVoiceRepliesStr,
  };
}

// ─────────────────────────────────────────────────────────────
//  Public: push a completed lead to Sheets + local store
// ─────────────────────────────────────────────────────────────
/**
 * @param {object} lead
 *   { name, phone, service, last_message,
 *     voice_notes?: [{id,url,receivedAt}],
 *     voice_transcriptions?: string[],
 *     ai_voice_replies?: [{mediaId,sentAt}],
 *     callback_requested?: boolean,
 *     timestamp?: string }
 */
async function pushLeadToSheets(lead) {
  const row = _buildLeadRow(lead, "complete");

  leadsStore.push(row);
  console.log("[Sheets] 📋 Lead stored locally:", row);

  await _drainFailedQueue();
  await _pushWithRetry(row);
}

// ─────────────────────────────────────────────────────────────
//  Public: snapshot an incomplete/abandoned lead (dashboard only)
// ─────────────────────────────────────────────────────────────
/**
 * Called when a session TTL expires before the lead is complete.
 * Saves partial data to the local store (dashboard) but does NOT
 * push to Google Sheets.
 *
 * @param {object} partial
 *   { phone, name?, service?, last_message?,
 *     voice_notes?, voice_transcriptions?, ai_voice_replies?,
 *     callback_requested? }
 */
function saveIncompleatLead(partial) {
  if (!partial.phone) return;

  const snap = _buildLeadRow(partial, "incomplete");

  const alreadyComplete = leadsStore.some(
    (l) => l.phone === snap.phone && l.status === "complete"
  );
  if (alreadyComplete) return;

  const existing = leadsStore.findIndex(
    (l) => l.phone === snap.phone && l.status === "incomplete"
  );
  if (existing !== -1) leadsStore.splice(existing, 1);

  leadsStore.push(snap);
  console.log(`[Sheets] 📌 Incomplete lead snapshot saved for ${snap.phone}`);
}

/**
 * Return all leads (complete + incomplete) for the dashboard.
 */
function getAllLeads() {
  return leadsStore;
}

module.exports = { pushLeadToSheets, saveIncompleatLead, getAllLeads };
