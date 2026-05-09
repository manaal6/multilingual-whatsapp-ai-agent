// ─────────────────────────────────────────────────────────────
//  server.js — Entry point for WhatsApp AI Support System
// ─────────────────────────────────────────────────────────────
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");

const webhookRouter = require("./routes/webhook");
const dashboardRouter = require("./routes/dashboard");

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve the dashboard as static files
app.use("/dashboard", express.static(path.join(__dirname, "../dashboard")));

// ── Routes ────────────────────────────────────────────────────
// WhatsApp webhook (verify + receive)
app.use("/webhook", webhookRouter);

// Dashboard API — returns lead data from memory/sheets
app.use("/api", dashboardRouter);

// Root redirect
app.get("/", (req, res) => {
  res.redirect("/dashboard/dashboard.html");
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 WhatsApp AI Support running on http://localhost:${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}/dashboard/dashboard.html`);
  console.log(`🔗 Webhook:   http://localhost:${PORT}/webhook\n`);
});
