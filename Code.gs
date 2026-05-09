// ─────────────────────────────────────────────────────────────
//  Code.gs  v2 — Google Apps Script Web App
//
//  Changes:
//  • Handles new columns: voice_notes, has_voice_notes,
//    callback_request, status
//  • Parses e.postData.contents as JSON robustly
//  • Returns proper JSON responses (not plain text)
//  • Auto-creates "Leads" sheet with updated header row
//
//  SETUP:
//  1. Open your Google Sheet → Extensions → Apps Script
//  2. Delete existing code, paste this file
//  3. Replace SHEET_ID below with your actual Sheet ID
//  4. Save → Deploy → New deployment → Web App
//     Execute as: Me | Who has access: Anyone
//  5. Authorize → copy the Web App URL into .env SHEETS_WEBHOOK_URL
// ─────────────────────────────────────────────────────────────

var SHEET_ID = "YOUR_GOOGLE_SHEET_ID_HERE"; // ← replace this

function doPost(e) {
  try {
    // ── Parse JSON body ───────────────────────────────────────
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse("error", "No POST body received");
    }

    var data = JSON.parse(e.postData.contents);

    // ── Open sheet, create if missing ────────────────────────
    var ss    = SpreadsheetApp.openById(SHEET_ID);
    var sheet = ss.getSheetByName("Leads");

    if (!sheet) {
      sheet = ss.insertSheet("Leads");
      var headers = [
        "Name", "Phone", "Service",
        "Last Message", "Voice Notes", "Has Voice Notes",
        "Callback Request", "Timestamp", "Status"
      ];
      var headerRange = sheet.getRange(1, 1, 1, headers.length);
      headerRange.setValues([headers]);
      headerRange.setBackground("#0f172a");
      headerRange.setFontColor("#00ff85");
      headerRange.setFontWeight("bold");
      sheet.setFrozenRows(1);
      // Set column widths for readability
      sheet.setColumnWidth(4, 200); // Last Message
      sheet.setColumnWidth(5, 300); // Voice Notes
    }

    // ── Append lead row ───────────────────────────────────────
    sheet.appendRow([
      data.name             || "Unknown",
      data.phone            || "Unknown",
      data.service          || "General Inquiry",
      data.last_message     || "",
      data.voice_notes      || "",         // "url1 | url2" string
      data.has_voice_notes  || "No",
      data.callback_request || "No",
      data.timestamp        || new Date().toISOString(),
      data.status           || "complete",
    ]);

    return jsonResponse("success", "Lead saved");

  } catch (err) {
    return jsonResponse("error", err.toString());
  }
}

function doGet(e) {
  return jsonResponse("ok", "Priya AI Support — Sheets webhook is live");
}

function jsonResponse(status, message) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: status, message: message }))
    .setMimeType(ContentService.MimeType.JSON);
}
