/* ============================================================
   TypeTrack — app.js
   Data pipeline: CSV parse → filter → compute → render charts
   ============================================================ */

'use strict';

// ---- Chart.js global defaults --------------------------------
const CYAN   = '#00d4ff';
const AMBER  = '#ffaa00';
const GREEN  = '#00e5a0';
const RED    = '#ff4d6a';
const MUTED  = '#6b7a9a';
const SURFACE2 = '#1a1f2e';
const BORDER = '#1e2330';

// ---- State ---------------------------------------------------
let allRows  = [];   // parsed CSV, sorted by date
let filtered = [];   // currently active window
let activeRange = 'all';

// Chart instances (kept for destroy-on-redraw)
const charts = {};

// ---- Boot sequence -------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  setupFilterTabs();
  loadCSV();
});

// ---- Filter Tab wiring ---------------------------------------
function setupFilterTabs() {
  document.querySelectorAll('.filter-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeRange = btn.dataset.range;
      filtered = applyRange(allRows, activeRange);
      renderAll(filtered);
    });
  });
}

// ---- CSV Load ------------------------------------------------
async function loadCSV() {
  setStatus('loading', 'Loading typing.csv…');
  try {
    const res = await fetch('data/typing.csv');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    allRows = parseCSV(text);
    if (allRows.length === 0) {
      setStatus('ready', 'No data rows found in CSV.');
      showEmpty();
      return;
    }
    filtered = applyRange(allRows, activeRange);
    setStatus('ready', `${allRows.length} sessions loaded · last updated ${allRows[allRows.length - 1].date}`);
    hideEmpty();
    renderAll(filtered);
  } catch (err) {
    setStatus('error', `Failed to load data/typing.csv — ${err.message}`);
    showEmpty();
  }
}

// ---- CSV Parsing ---------------------------------------------
function parseCSV(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];

  const header = lines[0].split(',').map(h => h.trim());
  const idx = {};
  header.forEach((h, i) => idx[h] = i);

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length < 5) continue;           // skip malformed rows
    const date = parts[idx.date]?.trim();
    const wpm  = parseFloat(parts[idx.wpm]);
    const raw  = parseFloat(parts[idx.raw]);
    const acc  = parseFloat(parts[idx.accuracy]);
    const con  = parseFloat(parts[idx.consistency]);
    const dur  = parseFloat(parts[idx.test_duration]) || 60;
    const note = (parts[idx.notes] || '').trim();

    if (!date || isNaN(wpm) || isNaN(acc)) continue;   // skip invalid

    rows.push({
      date, wpm, raw, accuracy: acc, consistency: con,
      duration: dur, notes: note,
      score: +(wpm * (acc / 100)).toFixed(1)
    });
  }

  // Sort ascending by date
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

// ---- Date Range Filter ---------------------------------------
function applyRange(rows, range) {
  if (range === 'all' || rows.length === 0) return rows;
  const days = { '7d': 7, '30d': 30, '90d': 90 }[range];
  if (!days) return rows;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutStr = cutoff.toISOString().slice(0, 10);
  return rows.filter(r => r.date >= cutStr);
}

// ---- Moving Average ------------------------------------------
function movingAvg(arr, key, window = 7) {
  return arr.map((_, i) => {
    const start = Math.max(0, i - window + 1);
    const slice = arr.slice(start, i + 1);
    const avg = slice.reduce((s, r) => s + r[key], 0) / slice.length;
    return +avg.toFixed(2);
  });
}

// ---- Linear Regression ---------------------------------------
function linearRegression(ys) {
  const n = ys.length;
  if (n < 2) return { slope: 0, intercept: ys[0] || 0 };
  const xs = ys.map((_, i) => i);
  const sumX  = xs.reduce((a, b) => a + b, 0);
  const sumY  = ys.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((s, x, i) => s + x * ys[i], 0);
  const sumX2 = xs.reduce((s, x) => s + x * x, 0);
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

// ---- Streak calculation --------------------------------------
function calcStreak(rows) {
  if (rows.length === 0) return 0;
  const dates = new Set(rows.map(r => r.date));
  let streak = 0;
  const today = new Date();
  for (let i = 0; i < 365; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const str = d.toISOString().slice(0, 10);
    if (dates.has(str)) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

// ---- Status Bar ----------------------------------------------
function setStatus(state, msg) {
  const dot  = document.querySelector('.status-dot');
  const text = document.querySelector('.status-text');
  dot.className = `status-dot ${state}`;
  text.textContent = msg;
}

function showEmpty() { document.querySelector('.empty-state').classList.add('visible'); }
function hideEmpty() { document.querySelector('.empty-state').classList.remove('visible'); }

// ---- Format helpers ------------------------------------------
function fmt(n, dp = 0) { return isNaN(n) ? '—' : n.toFixed(dp); }
function fmtDate(str) {
  if (!str) return '—';
  const [y, m, d] = str.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[+m - 1]} ${+d}, ${y}`;
}
function shortDate(str) {
  if (!str) return '—';
  const [, m, d] = str.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[+m - 1]} ${+d}`;
}

// ---- Render All ----------------------------------------------
function renderAll(rows) {
  renderHeroStats(rows);
  renderWPMChart(rows);
  renderScoreChart(rows);
  renderAccuracyChart(rows);
  renderConsistencyChart(rows);
  renderScatterChart(rows);
  renderHeatmap(allRows);   // heatmap always uses full dataset
  renderRecords(rows);
  renderMilestones(allRows);
  renderPrediction(rows);
  updateFooter(rows);
}

// ---- Hero Stats ----------------------------------------------
function renderHeroStats(rows) {
  if (rows.length === 0) return;

  const last = rows[rows.length - 1];
  const best = rows.reduce((m, r) => r.wpm > m.wpm ? r : m, rows[0]);
  const streak = calcStreak(rows);

  // 7-day avg WPM (use last 7 from filtered set)
  const last7 = rows.slice(-7);
  const avg7  = last7.reduce((s, r) => s + r.wpm, 0) / last7.length;

  set('stat-wpm',        fmt(last.wpm));
  set('stat-best',       fmt(best.wpm));
  set('stat-avg7',       fmt(avg7, 1));
  set('stat-accuracy',   fmt(last.accuracy, 1) + '%');
  set('stat-streak',     streak);
  set('stat-days',       rows.length);
}

function set(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

// ---- Chart.js default config factory -------------------------
function baseChartConfig(type, datasets, labels, extra = {}) {
  return {
    type,
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400, easing: 'easeOutQuart' },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          labels: {
            color: MUTED,
            font: { family: "'Inter', sans-serif", size: 11 },
            boxWidth: 10,
            boxHeight: 2,
            usePointStyle: true,
            pointStyleWidth: 16,
            padding: 16
          }
        },
        tooltip: {
          backgroundColor: SURFACE2,
          borderColor: BORDER,
          borderWidth: 1,
          titleColor: '#e2e8f0',
          bodyColor: MUTED,
          padding: 12,
          titleFont: { family: "'Space Grotesk', sans-serif", size: 12, weight: '600' },
          bodyFont: { family: "'JetBrains Mono', monospace", size: 11 },
          cornerRadius: 8,
          displayColors: false,
          ...extra.tooltip
        }
      },
      scales: {
        x: {
          grid: { color: BORDER, drawBorder: false },
          ticks: {
            color: MUTED,
            font: { family: "'JetBrains Mono', monospace", size: 10 },
            maxTicksLimit: 10,
            maxRotation: 0
          }
        },
        y: {
          grid: { color: BORDER, drawBorder: false },
          ticks: {
            color: MUTED,
            font: { family: "'JetBrains Mono', monospace", size: 10 }
          }
        },
        ...extra.scales
      },
      ...extra.options
    }
  };
}

function destroyChart(id) {
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
}

// ---- Chart 1: WPM Growth ------------------------------------
function renderWPMChart(rows) {
  destroyChart('wpm');
  if (rows.length === 0) return;

  const labels = rows.map(r => shortDate(r.date));
  const wpms   = rows.map(r => r.wpm);
  const avgs   = movingAvg(rows, 'wpm', 7);

  // Personal best index
  const pbIdx  = rows.indexOf(rows.reduce((m, r) => r.wpm > m.wpm ? r : m, rows[0]));

  const ctx = document.getElementById('chart-wpm').getContext('2d');

  // Gradient fill for WPM line
  const grad = ctx.createLinearGradient(0, 0, 0, 340);
  grad.addColorStop(0, 'rgba(0, 212, 255, 0.18)');
  grad.addColorStop(1, 'rgba(0, 212, 255, 0)');

  charts.wpm = new Chart(ctx, baseChartConfig('line', [
    {
      label: 'WPM',
      data: wpms,
      borderColor: CYAN,
      backgroundColor: grad,
      borderWidth: 1.5,
      pointRadius: rows.length > 60 ? 0 : 3,
      pointHoverRadius: 5,
      pointBackgroundColor: wpms.map((_, i) => i === pbIdx ? AMBER : CYAN),
      pointRadius: wpms.map((_, i) => i === pbIdx ? 6 : (rows.length > 60 ? 0 : 2)),
      tension: 0.35,
      fill: true,
      order: 2
    },
    {
      label: '7-day avg',
      data: avgs,
      borderColor: AMBER,
      backgroundColor: 'transparent',
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.4,
      borderDash: [],
      order: 1
    }
  ], labels, {
    tooltip: {
      callbacks: {
        title: (items) => rows[items[0].dataIndex]?.date || items[0].label,
        afterBody: (items) => {
          const r = rows[items[0].dataIndex];
          const lines = [`Accuracy: ${fmt(r?.accuracy, 1)}%`];
          if (r?.notes) lines.push(`Note: ${r.notes}`);
          return lines;
        }
      }
    },
    options: {
      plugins: { annotation: {} }
    }
  }));
}

// ---- Chart 2: Typing Score ----------------------------------
function renderScoreChart(rows) {
  destroyChart('score');
  if (rows.length === 0) return;

  const labels = rows.map(r => shortDate(r.date));
  const scores = rows.map(r => r.score);
  const avgs   = movingAvg(rows, 'score', 7);

  const ctx = document.getElementById('chart-score').getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 280);
  grad.addColorStop(0, 'rgba(255, 170, 0, 0.14)');
  grad.addColorStop(1, 'rgba(255, 170, 0, 0)');

  charts.score = new Chart(ctx, baseChartConfig('line', [
    {
      label: 'Score',
      data: scores,
      borderColor: AMBER,
      backgroundColor: grad,
      borderWidth: 1.5,
      pointRadius: rows.length > 60 ? 0 : 2,
      pointHoverRadius: 5,
      tension: 0.35,
      fill: true,
      order: 2
    },
    {
      label: '7-day avg',
      data: avgs,
      borderColor: GREEN,
      backgroundColor: 'transparent',
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.4,
      order: 1
    }
  ], labels, {
    tooltip: {
      callbacks: {
        title: (items) => rows[items[0].dataIndex]?.date || items[0].label,
        afterBody: (items) => {
          const r = rows[items[0].dataIndex];
          return [`WPM: ${r?.wpm}`, `Accuracy: ${fmt(r?.accuracy, 1)}%`];
        }
      }
    }
  }));
}

// ---- Chart 3: Accuracy Trend --------------------------------
function renderAccuracyChart(rows) {
  destroyChart('accuracy');
  if (rows.length === 0) return;

  const labels = rows.map(r => shortDate(r.date));
  const vals   = rows.map(r => r.accuracy);
  const avgs   = movingAvg(rows, 'accuracy', 7);

  const ctx = document.getElementById('chart-accuracy').getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 280);
  grad.addColorStop(0, 'rgba(0, 229, 160, 0.14)');
  grad.addColorStop(1, 'rgba(0, 229, 160, 0)');

  charts.accuracy = new Chart(ctx, baseChartConfig('line', [
    {
      label: 'Accuracy %',
      data: vals,
      borderColor: GREEN,
      backgroundColor: grad,
      borderWidth: 1.5,
      pointRadius: rows.length > 60 ? 0 : 2,
      pointHoverRadius: 5,
      tension: 0.35,
      fill: true,
      order: 2
    },
    {
      label: '7-day avg',
      data: avgs,
      borderColor: CYAN,
      backgroundColor: 'transparent',
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.4,
      order: 1
    }
  ], labels, {
    scales: {
      y: {
        min: Math.max(80, Math.floor(Math.min(...vals) - 2)),
        max: 100
      }
    }
  }));
}

// ---- Chart 4: Consistency Trend -----------------------------
function renderConsistencyChart(rows) {
  destroyChart('consistency');
  if (rows.length === 0) return;

  const labels = rows.map(r => shortDate(r.date));
  const vals   = rows.map(r => r.consistency);
  const avgs   = movingAvg(rows, 'consistency', 7);

  const ctx = document.getElementById('chart-consistency').getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 280);
  grad.addColorStop(0, 'rgba(255, 77, 106, 0.12)');
  grad.addColorStop(1, 'rgba(255, 77, 106, 0)');

  charts.consistency = new Chart(ctx, baseChartConfig('line', [
    {
      label: 'Consistency %',
      data: vals,
      borderColor: RED,
      backgroundColor: grad,
      borderWidth: 1.5,
      pointRadius: rows.length > 60 ? 0 : 2,
      pointHoverRadius: 5,
      tension: 0.35,
      fill: true,
      order: 2
    },
    {
      label: '7-day avg',
      data: avgs,
      borderColor: AMBER,
      backgroundColor: 'transparent',
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.4,
      order: 1
    }
  ], labels));
}

// ---- Chart 5: Speed vs Accuracy Scatter ----------------------
function renderScatterChart(rows) {
  destroyChart('scatter');
  if (rows.length === 0) return;

  const data = rows.map(r => ({ x: r.accuracy, y: r.wpm, date: r.date }));

  // Color points by recency
  const n = data.length;
  const colors = data.map((_, i) => {
    const t = i / Math.max(n - 1, 1);
    return `rgba(0, 212, 255, ${0.3 + t * 0.7})`;
  });

  const ctx = document.getElementById('chart-scatter').getContext('2d');

  charts.scatter = new Chart(ctx, {
    type: 'scatter',
    data: {
      datasets: [{
        label: 'Sessions',
        data,
        backgroundColor: colors,
        borderColor: 'transparent',
        pointRadius: 5,
        pointHoverRadius: 8,
        pointHoverBackgroundColor: AMBER,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400 },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: SURFACE2,
          borderColor: BORDER,
          borderWidth: 1,
          titleColor: '#e2e8f0',
          bodyColor: MUTED,
          padding: 12,
          cornerRadius: 8,
          titleFont: { family: "'Space Grotesk', sans-serif", size: 12, weight: '600' },
          bodyFont: { family: "'JetBrains Mono', monospace", size: 11 },
          callbacks: {
            title: (items) => items[0]?.raw?.date || '',
            label: (item) => [
              `WPM: ${item.raw.y}`,
              `Accuracy: ${item.raw.x}%`
            ]
          }
        }
      },
      scales: {
        x: {
          title: {
            display: true,
            text: 'Accuracy (%)',
            color: MUTED,
            font: { family: "'Inter', sans-serif", size: 11 }
          },
          grid: { color: BORDER },
          ticks: { color: MUTED, font: { family: "'JetBrains Mono', monospace", size: 10 } }
        },
        y: {
          title: {
            display: true,
            text: 'WPM',
            color: MUTED,
            font: { family: "'Inter', sans-serif", size: 11 }
          },
          grid: { color: BORDER },
          ticks: { color: MUTED, font: { family: "'JetBrains Mono', monospace", size: 10 } }
        }
      }
    }
  });
}

// ---- Heatmap -------------------------------------------------
function renderHeatmap(rows) {
  const container = document.getElementById('heatmap-grid');
  const monthsEl  = document.getElementById('heatmap-months');
  const tooltip   = document.getElementById('heatmap-tooltip');
  if (!container) return;

  // Build a Set of date → row for quick lookup
  const dateMap = new Map();
  rows.forEach(r => dateMap.set(r.date, r));

  const wpms = rows.map(r => r.wpm);
  const maxWpm = wpms.length ? Math.max(...wpms) : 100;
  const minWpm = wpms.length ? Math.min(...wpms) : 0;

  // Generate 52 weeks worth of cells (going back from today)
  const today = new Date();
  const WEEKS  = 52;

  // Start from Sunday WEEKS weeks ago
  const start = new Date(today);
  start.setDate(start.getDate() - (WEEKS * 7) + 1);
  // Align to Sunday
  start.setDate(start.getDate() - start.getDay());

  container.innerHTML  = '';
  monthsEl.innerHTML   = '';

  const monthPositions = [];  // { label, weekIndex }
  let lastMonth = -1;

  for (let w = 0; w < WEEKS; w++) {
    const weekEl = document.createElement('div');
    weekEl.className = 'heatmap-week';

    for (let d = 0; d < 7; d++) {
      const day = new Date(start);
      day.setDate(start.getDate() + w * 7 + d);
      const dateStr = day.toISOString().slice(0, 10);

      // Track month changes
      if (d === 0 && day.getMonth() !== lastMonth) {
        lastMonth = day.getMonth();
        monthPositions.push({ label: day.toLocaleString('default', { month: 'short' }), weekIndex: w });
      }

      const cell = document.createElement('div');
      cell.className = 'heatmap-cell';

      if (day > today) {
        cell.style.opacity = '0.2';
      } else if (dateMap.has(dateStr)) {
        const r = dateMap.get(dateStr);
        // Level 1–4 based on WPM relative to personal range
        const t = maxWpm > minWpm ? (r.wpm - minWpm) / (maxWpm - minWpm) : 1;
        const level = Math.ceil(t * 4) || 1;
        cell.dataset.level = level;
        cell.dataset.date  = dateStr;
        cell.dataset.wpm   = r.wpm;
        cell.dataset.acc   = r.accuracy;

        // Tooltip
        cell.addEventListener('mouseenter', (e) => {
          tooltip.innerHTML = `<strong>${fmtDate(dateStr)}</strong><br>${r.wpm} WPM · ${fmt(r.accuracy, 1)}% acc`;
          tooltip.style.display = 'block';
          positionTooltip(e, tooltip);
        });
        cell.addEventListener('mousemove',  (e) => positionTooltip(e, tooltip));
        cell.addEventListener('mouseleave', ()  => { tooltip.style.display = 'none'; });
      }

      weekEl.appendChild(cell);
    }
    container.appendChild(weekEl);
  }

  // Month labels
  monthPositions.forEach(({ label, weekIndex }) => {
    const span = document.createElement('div');
    span.className = 'heatmap-month-label';
    // Each week is 13+3=16px wide
    span.style.minWidth = '16px';
    span.textContent = label;
    monthsEl.appendChild(span);
  });
}

function positionTooltip(e, tooltip) {
  tooltip.style.left = (e.clientX + 12) + 'px';
  tooltip.style.top  = (e.clientY - 36) + 'px';
}

// ---- Personal Records ----------------------------------------
function renderRecords(rows) {
  if (rows.length === 0) return;

  const byWpm  = rows.reduce((m, r) => r.wpm > m.wpm ? r : m, rows[0]);
  const byAcc  = rows.reduce((m, r) => r.accuracy > m.accuracy ? r : m, rows[0]);
  const byCon  = rows.reduce((m, r) => r.consistency > m.consistency ? r : m, rows[0]);
  const byScore= rows.reduce((m, r) => r.score > m.score ? r : m, rows[0]);

  const records = [
    { id: 'rec-wpm',   label: 'Best WPM',      value: byWpm.wpm,              unit: ' WPM',  date: byWpm.date },
    { id: 'rec-acc',   label: 'Best Accuracy',  value: fmt(byAcc.accuracy, 1), unit: '%',     date: byAcc.date },
    { id: 'rec-con',   label: 'Best Consistency',value: fmt(byCon.consistency, 0), unit: '%', date: byCon.date },
    { id: 'rec-score', label: 'Best Score',     value: fmt(byScore.score, 1),  unit: '',      date: byScore.date },
  ];

  const el = document.getElementById('records-list');
  if (!el) return;

  el.innerHTML = records.map(r => `
    <div class="record-row">
      <div>
        <div class="record-name">${r.label}</div>
        <div class="record-date">${fmtDate(r.date)}</div>
      </div>
      <div class="record-value">${r.value}<span style="font-size:0.7rem;color:var(--text-muted);font-weight:400">${r.unit}</span></div>
    </div>
  `).join('');
}

// ---- Milestones ----------------------------------------------
const MILESTONE_DEFS = [
  { key: 'wpm-60',  label: 'First 60 WPM',        check: r => r.wpm >= 60  },
  { key: 'wpm-70',  label: 'First 70 WPM',        check: r => r.wpm >= 70  },
  { key: 'wpm-80',  label: 'First 80 WPM',        check: r => r.wpm >= 80  },
  { key: 'wpm-90',  label: 'First 90 WPM',        check: r => r.wpm >= 90  },
  { key: 'wpm-100', label: 'First 100 WPM',       check: r => r.wpm >= 100 },
  { key: 'wpm-110', label: 'First 110 WPM',       check: r => r.wpm >= 110 },
  { key: 'acc-95',  label: 'First 95% Accuracy',  check: r => r.accuracy >= 95 },
  { key: 'acc-98',  label: 'First 98% Accuracy',  check: r => r.accuracy >= 98 },
  { key: 'acc-99',  label: 'First 99% Accuracy',  check: r => r.accuracy >= 99 },
  { key: 'streak-7',  label: '7-Day Streak',      check: null, streakTarget: 7  },
  { key: 'streak-10', label: '10-Day Streak',     check: null, streakTarget: 10 },
  { key: 'streak-30', label: '30-Day Streak',     check: null, streakTarget: 30 },
];

function renderMilestones(rows) {
  const el = document.getElementById('milestones-list');
  if (!el || rows.length === 0) return;

  // Compute streak history
  const streakHistory = computeStreakHistory(rows);

  const achieved = [];
  const pending  = [];

  MILESTONE_DEFS.forEach(m => {
    if (m.streakTarget) {
      const hit = streakHistory.find(s => s.streak >= m.streakTarget);
      if (hit) achieved.push({ ...m, date: hit.date });
      else     pending.push(m);
    } else {
      const hit = rows.find(m.check);
      if (hit) achieved.push({ ...m, date: hit.date });
      else     pending.push(m);
    }
  });

  // Sort achieved by date
  achieved.sort((a, b) => a.date.localeCompare(b.date));

  const items = [
    ...achieved.map(m => `
      <div class="milestone-item">
        <div class="milestone-dot"></div>
        <div class="milestone-text">${m.label}</div>
        <div class="milestone-date">${shortDate(m.date)}</div>
      </div>
    `),
    ...pending.map(m => `
      <div class="milestone-item">
        <div class="milestone-dot locked"></div>
        <div class="milestone-text locked">${m.label}</div>
        <div class="milestone-date">—</div>
      </div>
    `)
  ];

  el.innerHTML = items.join('');
}

// Compute rolling streak at each date
function computeStreakHistory(rows) {
  const dateSet = new Set(rows.map(r => r.date));
  const result  = [];

  rows.forEach(r => {
    let streak = 0;
    const d = new Date(r.date);
    while (true) {
      const s = d.toISOString().slice(0, 10);
      if (dateSet.has(s)) { streak++; d.setDate(d.getDate() - 1); }
      else break;
    }
    result.push({ date: r.date, streak });
  });
  return result;
}

// ---- Trend Prediction ----------------------------------------
function renderPrediction(rows) {
  const el = document.getElementById('prediction-panel');
  if (!el) return;

  if (rows.length < 7) {
    el.innerHTML = `<p class="prediction-fallback">Log at least 7 sessions to see trend predictions.</p>`;
    return;
  }

  const wpms = rows.map(r => r.wpm);
  const { slope, intercept } = linearRegression(wpms);
  const currentWpm = wpms[wpms.length - 1];

  // days/wpm
  const ratePerDay = slope;   // WPM gained per session (approx 1 session/day)

  const targets = [90, 100, 110];
  const current = rows.length - 1;

  const rateLabel = ratePerDay >= 0
    ? `+${(ratePerDay * 7).toFixed(2)} WPM/week`
    : `${(ratePerDay * 7).toFixed(2)} WPM/week`;

  el.innerHTML = `
    <div class="prediction-current">
      <div class="prediction-rate">${rateLabel}</div>
      <div class="prediction-rate-label">improvement rate</div>
    </div>
    <div class="prediction-goals">
      ${targets.map(t => {
        if (currentWpm >= t) {
          const pct = 100;
          return `
            <div class="prediction-goal">
              <div class="prediction-goal-header">
                <span class="prediction-goal-label">${t} WPM</span>
                <span class="prediction-goal-days" style="color:var(--green)">Achieved ✓</span>
              </div>
              <div class="prediction-goal-bar">
                <div class="prediction-goal-fill done" style="width:100%"></div>
              </div>
            </div>`;
        }
        if (slope <= 0) {
          return `
            <div class="prediction-goal">
              <div class="prediction-goal-header">
                <span class="prediction-goal-label">${t} WPM</span>
                <span class="prediction-goal-days">Keep practicing!</span>
              </div>
              <div class="prediction-goal-bar">
                <div class="prediction-goal-fill" style="width:${Math.round((currentWpm / t) * 100)}%"></div>
              </div>
            </div>`;
        }
        const daysNeeded = Math.ceil((t - (intercept + slope * current)) / slope);
        const pct = Math.min(99, Math.round((currentWpm / t) * 100));
        return `
          <div class="prediction-goal">
            <div class="prediction-goal-header">
              <span class="prediction-goal-label">${t} WPM</span>
              <span class="prediction-goal-days">~${daysNeeded} day${daysNeeded !== 1 ? 's' : ''}</span>
            </div>
            <div class="prediction-goal-bar">
              <div class="prediction-goal-fill" style="width:${pct}%"></div>
            </div>
          </div>`;
      }).join('')}
    </div>
  `;
}

// ---- Footer --------------------------------------------------
function updateFooter(rows) {
  const el = document.getElementById('footer-meta');
  if (!el || rows.length === 0) return;
  const last = rows[rows.length - 1];
  el.innerHTML = `<span>${rows.length}</span> sessions logged · last updated <span>${fmtDate(last.date)}</span>`;
}
