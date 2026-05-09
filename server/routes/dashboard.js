// ─────────────────────────────────────────────────────────────
//  routes/dashboard.js — REST API endpoints for the dashboard
// ─────────────────────────────────────────────────────────────
const express = require("express");
const router = express.Router();
const { getAllLeads } = require("../helpers/sheets");

// ── GET /api/leads — Return all captured leads ────────────────
router.get("/leads", (req, res) => {
  const leads = getAllLeads();

  // Optional filter by date range via query param: ?range=today|week|month
  const range = req.query.range;
  const now = new Date();

  let filtered = leads;

  if (range === "today") {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    filtered = leads.filter((l) => new Date(l.timestamp) >= start);
  } else if (range === "week") {
    const start = new Date(now);
    start.setDate(now.getDate() - 7);
    filtered = leads.filter((l) => new Date(l.timestamp) >= start);
  } else if (range === "month") {
    const start = new Date(now);
    start.setDate(now.getDate() - 30);
    filtered = leads.filter((l) => new Date(l.timestamp) >= start);
  }

  res.json({
    total: filtered.length,
    leads: filtered.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)),
  });
});

// ── GET /api/stats — Summary stats for the dashboard cards ───
router.get("/stats", (req, res) => {
  const leads = getAllLeads();
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - 7);

  // Leads today
  const todayLeads = leads.filter((l) => new Date(l.timestamp) >= todayStart);

  // Leads this week
  const weekLeads = leads.filter((l) => new Date(l.timestamp) >= weekStart);

  // Service breakdown (count per service)
  const serviceCounts = {};
  for (const lead of leads) {
    const svc = lead.service || "Unknown";
    serviceCounts[svc] = (serviceCounts[svc] || 0) + 1;
  }

  // Last 5 messages
  const recent = [...leads]
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 5);

  res.json({
    total: leads.length,
    today: todayLeads.length,
    thisWeek: weekLeads.length,
    serviceCounts,
    recentLeads: recent,
  });
});

// ── GET /api/health — Health check ───────────────────────────
router.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime(), timestamp: new Date().toISOString() });
});

module.exports = router;
