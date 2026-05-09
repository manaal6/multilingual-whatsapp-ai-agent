// ─────────────────────────────────────────────────────────────
//  routes/webhook.js  v6  — multilingual production-ready
//
//  Changes over v5:
//  • Imports detectLanguage from groq.js
//  • Imports setDetectedLanguage from sessions.js
//  • Language detected from first text/transcript, stored once
//  • generateTTSAudio() receives language so correct TTS model used
//  • Everything else unchanged
// ─────────────────────────────────────────────────────────────
const express = require("express");
const router  = express.Router();

const { sendTextMessage, markAsRead } = require("../helpers/whatsapp");
const {
  getAIReply,
  parseLeadFromReply,
  extractPhoneFromText,
  detectLanguage,
} = require("../helpers/groq");
const { pushLeadToSheets } = require("../helpers/sheets");
const {
  fetchMediaUrl,
  isCallbackRequest,
  getCallbackReply,
  buildVoiceNoteContext,
  addAiVoiceReply,
} = require("../helpers/voice");
const { transcribeAudio }    = require("../helpers/transcribe");
const { generateTTSAudio }   = require("../helpers/tts");
const { uploadAndSendAudio } = require("../helpers/media");
const {
  getSession,
  getSessionMeta,
  appendMessage,
  updatePartialLead,
  addVoiceNote,
  setCallbackRequested,
  setDetectedLanguage,
  markLeadCaptured,
  resetSession,
} = require("../helpers/sessions");

// ── GET /webhook — Meta verification ─────────────────────────
router.get("/", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log("[Webhook] ✅ Webhook verified");
    return res.status(200).send(challenge);
  }
  console.warn("[Webhook] ❌ Verification failed");
  return res.sendStatus(403);
});

// ── POST /webhook ─────────────────────────────────────────────
router.post("/", async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    if (
      body.object !== "whatsapp_business_account" ||
      !body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]
    ) return;

    const value       = body.entry[0].changes[0].value;
    const message     = value.messages[0];
    const senderPhone = message.from;
    const messageId   = message.id;
    const msgType     = message.type;

    await markAsRead(messageId).catch((e) =>
      console.warn("[Webhook] markAsRead non-fatal:", e.message)
    );

    const session = getSession(senderPhone);
    const rawText = msgType === "text" ? (message.text?.body || "") : "";

    // ── "new" → reset ────────────────────────────────────────
    if (rawText.toLowerCase().trim() === "new") {
      resetSession(senderPhone);
      await sendTextMessage(senderPhone, "Sure! Let's start fresh. How can I help you today? 😊");
      return;
    }

    // ── Already captured ─────────────────────────────────────
    if (session.leadCaptured) {
      await sendTextMessage(
        senderPhone,
        "Hi again! 👋 Your request is already logged. Type *new* to start a fresh conversation."
      );
      return;
    }

    // ── Detect language from text messages ───────────────────
    if (msgType === "text" && rawText.trim()) {
      const lang = detectLanguage(rawText);
      setDetectedLanguage(senderPhone, lang);
    }

    // ─────────────────────────────────────────────────────────
    //  VOICE NOTE — transcribe first, detect language from transcript
    // ─────────────────────────────────────────────────────────
    let userText      = rawText;
    let voiceMediaId  = null;
    let voiceMediaUrl = null;
    let transcript    = null;

    if (msgType === "audio") {
      voiceMediaId  = message.audio?.id;

      if (voiceMediaId) {
        voiceMediaUrl = await fetchMediaUrl(voiceMediaId);
        addVoiceNote(senderPhone, voiceMediaId, voiceMediaUrl);

        // Transcribe synchronously — AI needs this before replying
        if (voiceMediaUrl) {
          const result = await transcribeAudio(voiceMediaUrl);
          if (result) {
            transcript = result.transcript;

            if (!Array.isArray(session.voice_transcriptions)) {
              session.voice_transcriptions = [];
            }
            session.voice_transcriptions.push(transcript);

            // Trust Deepgram/Whisper lang code — fixes ur vs hi confusion
            const scriptLang = detectLanguage(transcript);
            setDetectedLanguage(senderPhone, scriptLang, result.deepgramLangCode);

            console.log(`[Webhook] 📝 Transcript (${session.detected_language}): "${transcript.slice(0, 80)}"`);
          }
        }

        userText = buildVoiceNoteContext(voiceMediaId, voiceMediaUrl, transcript);
      }
    }

    // ─────────────────────────────────────────────────────────
    //  CALLBACK REQUEST
    // ─────────────────────────────────────────────────────────
    if (msgType === "text" && isCallbackRequest(userText)) {
      if (!session.callback_requested) {
        setCallbackRequested(senderPhone);
        const reply = getCallbackReply();
        await sendTextMessage(senderPhone, reply);
        appendMessage(senderPhone, "user", "[User requested a phone call/callback]");
        appendMessage(senderPhone, "assistant", reply);
        return;
      }
    }

    // ── Phone number detection ────────────────────────────────
    if (msgType === "text") {
      const detectedPhone = extractPhoneFromText(userText);
      if (detectedPhone) updatePartialLead(senderPhone, { phone: detectedPhone });
    }
    if (transcript) {
      const phoneInTranscript = extractPhoneFromText(transcript);
      if (phoneInTranscript) updatePartialLead(senderPhone, { phone: phoneInTranscript });
    }

    // ─────────────────────────────────────────────────────────
    //  AI REPLY — language-aware via sessionMeta.detected_language
    // ─────────────────────────────────────────────────────────
    appendMessage(senderPhone, "user", userText);

    const sessionMeta = getSessionMeta(senderPhone);
    const rawReply    = await getAIReply(session.messages, session.partial, sessionMeta);
    const { lead, cleanReply } = parseLeadFromReply(rawReply);

    appendMessage(senderPhone, "assistant", cleanReply);

    // ─────────────────────────────────────────────────────────
    //  SEND REPLY
    //  Voice note in → voice note out (correct language TTS model)
    //  Text in → text out
    // ─────────────────────────────────────────────────────────
    if (msgType === "audio") {
      let audioSent = false;

      const ttsResult = await generateTTSAudio(cleanReply, session.detected_language);
      if (ttsResult) {
        const sentMediaId = await uploadAndSendAudio(
          senderPhone,
          ttsResult.buffer,
          ttsResult.contentType
        );
        if (sentMediaId) {
          addAiVoiceReply(session, sentMediaId);
          audioSent = true;
          console.log(`[Webhook] ✅ AI voice reply (${session.detected_language}) sent to ${senderPhone}`);
        }
      }

      // Text fallback if TTS/upload failed
      if (!audioSent) {
        console.warn(`[Webhook] TTS failed — text fallback to ${senderPhone}`);
        await sendTextMessage(senderPhone, cleanReply);
      }

    } else {
      // Text message → text reply
      await sendTextMessage(senderPhone, cleanReply);
    }

    // ── Merge confirmed lead fields ───────────────────────────
    if (lead) {
      updatePartialLead(senderPhone, {
        name:    lead.name,
        phone:   lead.phone,
        service: lead.service,
      });
    }

    // ── Lead capture ──────────────────────────────────────────
    if (lead && !session.leadCaptured) {
      const finalLead = {
        name:                 session.partial.name    || lead.name    || "Unknown",
        phone:                session.partial.phone   || lead.phone   || senderPhone,
        service:              session.partial.service || lead.service || "General Inquiry",
        last_message:         msgType === "audio" ? `[Voice note] ${transcript || ""}`.trim() : userText,
        voice_notes:          session.voice_notes,
        voice_transcriptions: session.voice_transcriptions || [],
        ai_voice_replies:     session.ai_voice_replies     || [],
        callback_requested:   session.callback_requested,
        detected_language:    session.detected_language,
        timestamp:            new Date().toISOString(),
      };
      markLeadCaptured(senderPhone);
      await pushLeadToSheets(finalLead);
      console.log(`[Webhook] 🎯 Lead captured for ${senderPhone}:`, finalLead);
    }

  } catch (err) {
    console.error("[Webhook] Unhandled error:", err);
  }
});

module.exports = router;