// ─────────────────────────────────────────────────────────────
//  dashboard.js — Client-side logic for the Priya dashboard
// ─────────────────────────────────────────────────────────────

const API_BASE = window.location.origin + "/api";
const REFRESH_INTERVAL = 10; // seconds

let currentRange = "all";
let allLeads = [];
let serviceChartInstance = null;
let timelineChartInstance = null;
let barChartInstance = null;
let refreshTimer = null;
let countdown = REFRESH_INTERVAL;

// ── Chart.js global defaults ──────────────────────────────────
Chart.defaults.color = "#6b6b80";
Chart.defaults.borderColor = "#25252e";
Chart.defaults.font.family = "'DM Sans', system-ui, sans-serif";

// ── Init ──────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  setupNav();
  setupFilters();
  setupRefresh();
  setupMobileMenu();
  setupSearch();
  setupExport();
  loadData();
});

// ── Navigation ────────────────────────────────────────────────
function setupNav() {
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.addEventListener("click", (e) => {
      e.preventDefault();
      const sectionId = item.dataset.section;
      switchSection(sectionId);
      // Close mobile sidebar
      document.querySelector(".sidebar").classList.remove("open");
      document.querySelector(".sidebar-overlay")?.classList.remove("active");
    });
  });
}

function switchSection(id) {
  document.querySelectorAll(".nav-item").forEach((n) =>
    n.classList.toggle("active", n.dataset.section === id)
  );
  document.querySelectorAll(".section").forEach((s) =>
    s.classList.toggle("active", s.id === `section-${id}`)
  );
  const titles = { overview: "Overview", leads: "Leads", analytics: "Analytics" };
  document.getElementById("pageTitle").textContent = titles[id] || id;

  // Render analytics charts when switching to that tab
  if (id === "analytics" && allLeads.length > 0) {
    renderTimelineChart(allLeads);
    renderBarChart(allLeads);
  }
}

// ── Filters ───────────────────────────────────────────────────
function setupFilters() {
  document.querySelectorAll(".filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentRange = btn.dataset.range;
      loadData();
    });
  });
}

// ── Refresh ───────────────────────────────────────────────────
function setupRefresh() {
  document.getElementById("refreshBtn").addEventListener("click", () => {
    resetCountdown();
    loadData(true);
  });
  startCountdown();
}

function startCountdown() {
  countdown = REFRESH_INTERVAL;
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    countdown--;
    document.getElementById("refreshCountdown").textContent = `${countdown}s`;
    if (countdown <= 0) {
      loadData();
      resetCountdown();
    }
  }, 1000);
}

function resetCountdown() {
  countdown = REFRESH_INTERVAL;
  document.getElementById("refreshCountdown").textContent = `${countdown}s`;
  clearInterval(refreshTimer);
  startCountdown();
}

// ── Mobile sidebar ────────────────────────────────────────────
function setupMobileMenu() {
  // Create overlay dynamically
  const overlay = document.createElement("div");
  overlay.className = "sidebar-overlay";
  document.body.appendChild(overlay);

  document.getElementById("mobileMenuBtn").addEventListener("click", () => {
    document.querySelector(".sidebar").classList.toggle("open");
    overlay.classList.toggle("active");
  });

  overlay.addEventListener("click", () => {
    document.querySelector(".sidebar").classList.remove("open");
    overlay.classList.remove("active");
  });
}

// ── Table search ──────────────────────────────────────────────
function setupSearch() {
  document.getElementById("tableSearch").addEventListener("input", (e) => {
    const q = e.target.value.toLowerCase();
    const filtered = allLeads.filter(
      (l) =>
        (l.name || "").toLowerCase().includes(q) ||
        (l.phone || "").toLowerCase().includes(q) ||
        (l.service || "").toLowerCase().includes(q) ||
        (l.last_message || "").toLowerCase().includes(q)
    );
    renderTable(filtered);
  });
}

// ── CSV Export ────────────────────────────────────────────────
function setupExport() {
  document.getElementById("exportCsvBtn").addEventListener("click", () => {
    if (!allLeads.length) return alert("No leads to export yet.");
    const headers = ["Name", "Phone", "Service", "Last Message", "Timestamp"];
    const rows = allLeads.map((l) => [
      `"${(l.name || "").replace(/"/g, '""')}"`,
      `"${(l.phone || "").replace(/"/g, '""')}"`,
      `"${(l.service || "").replace(/"/g, '""')}"`,
      `"${(l.last_message || "").replace(/"/g, '""')}"`,
      `"${l.timestamp || ""}"`,
    ]);
    const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `priya-leads-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  });
}

// ── Data Loading ──────────────────────────────────────────────
async function loadData(spin = false) {
  if (spin) {
    const btn = document.getElementById("refreshBtn");
    btn.classList.add("spinning");
    setTimeout(() => btn.classList.remove("spinning"), 600);
  }

  try {
    const rangeParam = currentRange !== "all" ? `?range=${currentRange}` : "";

    const [statsRes, leadsRes] = await Promise.all([
      fetch(`${API_BASE}/stats${rangeParam}`),
      fetch(`${API_BASE}/leads${rangeParam}`),
    ]);

    const stats = await statsRes.json();
    const leadsData = await leadsRes.json();

    allLeads = leadsData.leads || [];

    updateStats(stats);
    renderRecentList(stats.recentLeads || []);
    renderServiceChart(stats.serviceCounts || {});
    renderTable(allLeads);

    // Re-render analytics charts if on that section
    if (document.getElementById("section-analytics").classList.contains("active")) {
      renderTimelineChart(allLeads);
      renderBarChart(allLeads);
    }

    setStatus("online", "Live");
  } catch (err) {
    console.error("[Dashboard] Load error:", err);
    setStatus("offline", "Offline");
  }
}

// ── Stats ─────────────────────────────────────────────────────
function updateStats(stats) {
  document.getElementById("statTotal").textContent = stats.total ?? 0;
  document.getElementById("statToday").textContent = stats.today ?? 0;
  document.getElementById("statWeek").textContent = stats.thisWeek ?? 0;
  document.getElementById("statServices").textContent =
    Object.keys(stats.serviceCounts || {}).length;
}

// ── Recent list ───────────────────────────────────────────────
function renderRecentList(leads) {
  const container = document.getElementById("recentList");
  if (!leads.length) {
    container.innerHTML = `<div class="empty-state">No leads yet. Waiting for messages… 💬</div>`;
    return;
  }

  container.innerHTML = leads
    .map(
      (l) => `
    <div class="recent-item">
      <div class="recent-avatar">${(l.name || "?")[0].toUpperCase()}</div>
      <div class="recent-info">
        <div class="recent-name">${escHtml(l.name || "Unknown")}</div>
        <div class="recent-service">${escHtml(l.service || "General")}</div>
      </div>
      <div class="recent-time">${relativeTime(l.timestamp)}</div>
    </div>`
    )
    .join("");
}

// ── Table ─────────────────────────────────────────────────────
function renderTable(leads) {
  const tbody = document.getElementById("leadsTableBody");
  if (!leads.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="table-empty">No leads captured yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = leads
    .map(
      (l, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${escHtml(l.name || "—")}</td>
      <td>${escHtml(l.phone || "—")}</td>
      <td><span class="service-tag">${escHtml(l.service || "General")}</span></td>
      <td>${escHtml((l.last_message || "").slice(0, 60))}</td>
      <td class="ts-cell">${formatTimestamp(l.timestamp)}</td>
    </tr>`
    )
    .join("");
}

// ── Doughnut chart — service breakdown ───────────────────────
function renderServiceChart(serviceCounts) {
  const canvas = document.getElementById("serviceChart");
  const emptyEl = document.getElementById("chartEmpty");
  const labels = Object.keys(serviceCounts);
  const values = Object.values(serviceCounts);

  if (!labels.length) {
    emptyEl.style.display = "block";
    canvas.style.display = "none";
    return;
  }

  emptyEl.style.display = "none";
  canvas.style.display = "block";

  const colors = ["#00ff85", "#4d9fff", "#ffb347", "#c084fc", "#ff5b5b", "#38bdf8"];

  if (serviceChartInstance) serviceChartInstance.destroy();

  serviceChartInstance = new Chart(canvas, {
    type: "doughnut",
    data: {
      labels,
      datasets: [
        {
          data: values,
          backgroundColor: colors.slice(0, labels.length),
          borderWidth: 0,
          hoverOffset: 6,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "68%",
      plugins: {
        legend: {
          position: "bottom",
          labels: { padding: 14, font: { size: 11 }, color: "#6b6b80", boxWidth: 10, borderRadius: 3 },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => ` ${ctx.label}: ${ctx.raw}`,
          },
        },
      },
    },
  });
}

// ── Line chart — leads over time ──────────────────────────────
function renderTimelineChart(leads) {
  const canvas = document.getElementById("timelineChart");
  if (!leads.length) return;

  // Group leads by day (last 14 days)
  const days = {};
  const today = new Date();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    days[key] = 0;
  }

  leads.forEach((l) => {
    const key = (l.timestamp || "").slice(0, 10);
    if (key in days) days[key]++;
  });

  const labels = Object.keys(days).map((d) => {
    const [, m, day] = d.split("-");
    return `${parseInt(day)} ${["", "Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][parseInt(m)]}`;
  });
  const data = Object.values(days);

  if (timelineChartInstance) timelineChartInstance.destroy();

  timelineChartInstance = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Leads",
          data,
          borderColor: "#00ff85",
          backgroundColor: "rgba(0,255,133,0.08)",
          borderWidth: 2,
          fill: true,
          tension: 0.4,
          pointBackgroundColor: "#00ff85",
          pointRadius: 3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: "#25252e" }, ticks: { maxRotation: 0, font: { size: 10 } } },
        y: { grid: { color: "#25252e" }, beginAtZero: true, ticks: { stepSize: 1 } },
      },
    },
  });
}

// ── Bar chart — top services ──────────────────────────────────
function renderBarChart(leads) {
  const canvas = document.getElementById("barChart");
  if (!leads.length) return;

  const counts = {};
  leads.forEach((l) => {
    const svc = l.service || "Unknown";
    counts[svc] = (counts[svc] || 0) + 1;
  });

  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const labels = sorted.map(([k]) => k);
  const data = sorted.map(([, v]) => v);
  const colors = ["#00ff85", "#4d9fff", "#ffb347", "#c084fc", "#ff5b5b", "#38bdf8"];

  if (barChartInstance) barChartInstance.destroy();

  barChartInstance = new Chart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Leads",
          data,
          backgroundColor: colors.slice(0, labels.length),
          borderRadius: 5,
          borderWidth: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: "y",
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: "#25252e" }, beginAtZero: true, ticks: { stepSize: 1 } },
        y: { grid: { display: false } },
      },
    },
  });
}

// ── Status indicator ──────────────────────────────────────────
function setStatus(state, label) {
  const dot = document.getElementById("statusDot");
  const text = document.getElementById("statusText");
  dot.className = `status-dot ${state}`;
  text.textContent = label;
}

// ── Utilities ─────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function relativeTime(ts) {
  if (!ts) return "—";
  const diff = Date.now() - new Date(ts).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function formatTimestamp(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleString("en-US", {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}
