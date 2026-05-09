// ─────────────────────────────────────────────────────────────
//  helpers/tts.js  v3
//
//  Changes over v2:
//  • generateTTSAudio() accepts optional language param
//  • Arabic/Urdu → canopylabs/orpheus-arabic-saudi model
//  • All other languages → canopylabs/orpheus-v1-english
//  • WAV→OGG conversion unchanged
// ─────────────────────────────────────────────────────────────
const fetch      = require("node-fetch");
const ffmpeg     = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const { tmpdir } = require("os");
const { join }   = require("path");
const fs         = require("fs");

ffmpeg.setFfmpegPath(ffmpegPath);

const GROQ_TTS_URL = "https://api.groq.com/openai/v1/audio/speech";

// Model + voice per language family
const TTS_PROFILES = {
"Arabic/Urdu": { model: "canopylabs/orpheus-arabic-saudi", voice: "noura",  format: "wav" },
"Hindi":       { model: "canopylabs/orpheus-arabic-saudi", voice: "noura",  format: "wav" },
  default:       { model: "canopylabs/orpheus-v1-english",   voice: "hannah", format: "wav" },
};

const MAX_INPUT_CHARS = 4000;
const TIMEOUT_MS      = 30000;
const MAX_RETRIES     = 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function _prepareText(text) {
  return text
    .replace(/LEAD_CAPTURED:\s*\{[^}]*\}/g, "")
    .replace(/[*_`]/g, "")
    .replace(/\[.*?\]/g, "")
    .trim()
    .slice(0, MAX_INPUT_CHARS);
}

function _wavToOgg(wavBuffer) {
  return new Promise((resolve, reject) => {
    const tmpIn  = join(tmpdir(), `tts_in_${Date.now()}.wav`);
    const tmpOut = join(tmpdir(), `tts_out_${Date.now()}.ogg`);

    fs.writeFileSync(tmpIn, wavBuffer);

    ffmpeg(tmpIn)
      .audioCodec("libopus")
      .audioChannels(1)
      .audioFrequency(16000)
      .format("ogg")
      .on("error", (err) => {
        fs.unlink(tmpIn,  () => {});
        fs.unlink(tmpOut, () => {});
        reject(err);
      })
      .on("end", () => {
        const oggBuffer = fs.readFileSync(tmpOut);
        fs.unlink(tmpIn,  () => {});
        fs.unlink(tmpOut, () => {});
        resolve(oggBuffer);
      })
      .save(tmpOut);
  });
}

/**
 * Generate TTS audio and convert to OGG/Opus for WhatsApp.
 *
 * @param {string} replyText
 * @param {string} language   — from detectLanguage(), e.g. "Arabic/Urdu", "English"
 * @returns {{ buffer: Buffer, contentType: "audio/ogg" } | null}
 */
async function generateTTSAudio(replyText, language = "English") {
  if (!replyText?.trim()) { console.warn("[TTS] Empty text."); return null; }
  if (!process.env.GROQ_API_KEY) { console.warn("[TTS] No GROQ_API_KEY."); return null; }

  const inputText = _prepareText(replyText);
  if (!inputText) { console.warn("[TTS] Text empty after sanitisation."); return null; }

  const profile = TTS_PROFILES[language] || TTS_PROFILES.default;
  console.log(`[TTS] Language: ${language} → model: ${profile.model}, voice: ${profile.voice}`);

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      console.log(`[TTS] 🔊 Generating: "${inputText.slice(0, 60)}…" (attempt ${attempt})`);

      const res = await fetch(GROQ_TTS_URL, {
        method:  "POST",
        headers: {
          Authorization:  `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Type": "application/json",
          Accept:         "audio/wav",
        },
        body: JSON.stringify({
          model:           profile.model,
          voice:           profile.voice,
          input:           inputText,
          response_format: profile.format,
        }),
        timeout: TIMEOUT_MS,
      });

      if (!res.ok) {
        let errMsg = `HTTP ${res.status}`;
        try { const d = await res.json(); errMsg = d?.error?.message || errMsg; } catch {}
        if (res.status === 429) { await sleep(3000 * attempt); continue; }
        if (res.status === 401 || res.status === 403) { console.error(`[TTS] Auth: ${errMsg}`); return null; }
        throw new Error(errMsg);
      }

      const wavBuffer = await res.buffer();
      if (!wavBuffer || wavBuffer.byteLength === 0) throw new Error("Empty WAV buffer");

      console.log(`[TTS] ✅ WAV: ${(wavBuffer.byteLength / 1024).toFixed(1)} KB — converting to OGG…`);

      const oggBuffer = await _wavToOgg(wavBuffer);
      console.log(`[TTS] ✅ OGG: ${(oggBuffer.byteLength / 1024).toFixed(1)} KB — ready`);

      return { buffer: oggBuffer, contentType: "audio/ogg" };

    } catch (err) {
      console.error(`[TTS] ❌ Attempt ${attempt}/${MAX_RETRIES + 1}: ${err.message}`);
      if (attempt <= MAX_RETRIES) await sleep(1500 * attempt);
    }
  }

  console.error("[TTS] All retries exhausted.");
  return null;
}

module.exports = { generateTTSAudio };