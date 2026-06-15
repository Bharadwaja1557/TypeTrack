/* ============================================================================
   TypeTrack — app.js
   ----------------------------------------------------------------------------
   A zero-dependency (besides Chart.js via CDN) dashboard that reads a local
   CSV of daily typing results and visualises improvement over time.

   Pipeline:  fetch CSV -> parse -> clean/sort -> derive metrics ->
              render hero stats, charts, heatmap, records, milestones, forecast

   The analytics functions (moving average, linear regression, streak,
   milestones, predictions) are pure and were unit-tested against the sample
   data before shipping. The DOM/Chart.js code lives below them.
   ========================================================================== */

'use strict';

/* ----------------------------------------------------------------------------
   CONFIG — change these to retune the dashboard
   -------------------------------------------------------------------------- */
const CONFIG = {
  CSV_PATH:    'data/typing.csv',
  MA_WINDOW:   7,                 // moving-average window (days) for trend lines
  WPM_TARGETS: [90, 100, 110],    // forecast goals (Trend Prediction panel)
  WPM_MS:      [70, 80, 90],      // WPM milestone thresholds
  ACC_MS:      [95, 98],          // accuracy milestone thresholds (%)
  STREAK_MS:   [10, 30],          // streak milestone thresholds (days)
  MIN_FORECAST_POINTS: 5,         // need at least this many entries to forecast
  DEFAULT_RANGE: 'all',           // initial chart range: 7 | 30 | 90 | all
};

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* Module state shared across renders */
const state = {
  rows: [],          // full, cleaned, sorted dataset
  charts: {},        // live Chart.js instances, keyed by id (for destroy/rebuild)
  theme: null,       // resolved CSS colour tokens
  chartLib: false,   // whether Chart.js actually loaded
};

/* ============================================================================
   1. SMALL UTILITIES
   ========================================================================== */

/** Convert an ISO date (YYYY-MM-DD) to a whole-day number (UTC, no TZ drift). */
const dayNum = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 864e5;
};

/** "2026-06-13" -> "Jun 13" */
function fmtShort(iso) {
  const [, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

/** "2026-06-13" -> "Jun 13, 2026" */
function fmtLong(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

/** Add `days` to an ISO date, returning a new ISO date. */
function addDaysISO(iso, days) {
  const ms = (dayNum(iso) + days) * 864e5;
  const dt = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

const round1 = (n) => Math.round(n * 10) / 10;

/** Parse "#rrggbb" -> [r,g,b]. */
function hexToRgb(hex) {
  const h = hex.replace('#', '').trim();
  const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16));
}

/** Linear blend between two hex colours; t in [0,1]. Returns "rgb(...)". */
function lerpColor(a, b, t) {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const m = (x, y) => Math.round(x + (y - x) * t);
  return `rgb(${m(ar, br)}, ${m(ag, bg)}, ${m(ab, bb)})`;
}

/* ============================================================================
   2. CSV LOADING + PARSING
   ========================================================================== */

/** Split one CSV line, honouring double-quoted fields (so notes may contain commas). */
function splitCSVLine(line) {
  const out = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }  // escaped quote
      else inQuotes = !inQuotes;
    } else if (c === ',' && !inQuotes) {
      out.push(cur); cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Parse CSV text into row objects, addressing columns by HEADER NAME so the
 * column order can change without breaking. Invalid/empty rows are skipped.
 * Expected header: date,wpm,raw,accuracy,consistency,test_duration,notes
 */
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');  // drop blank rows
  if (!lines.length) return [];

  const header = splitCSVLine(lines[0]).map((h) => h.trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  const di = col('date'), wi = col('wpm'), ri = col('raw'), ai = col('accuracy'),
        ci = col('consistency'), ti = col('test_duration'), ni = col('notes');

  const rows = [];
  for (let k = 1; k < lines.length; k++) {
    const c = splitCSVLine(lines[k]);
    const date = (c[di] || '').trim();
    const wpm = Number(c[wi]);
    const acc = Number(c[ai]);

    // A row is only usable if it has a date and at least valid wpm + accuracy.
    if (!date || Number.isNaN(wpm) || Number.isNaN(acc)) continue;

    rows.push({
      date,
      wpm,
      raw:         ri >= 0 && c[ri] !== '' ? Number(c[ri]) : null,
      accuracy:    acc,
      consistency: ci >= 0 && c[ci] !== '' ? Number(c[ci]) : null,
      duration:    ti >= 0 && c[ti] !== '' ? Number(c[ti]) : null,
      notes:       ni >= 0 ? (c[ni] || '').trim() : '',
    });
  }
  return rows;
}

/** Sort ascending by date and attach the derived Typing Score = WPM × accuracy/100. */
function prepData(rows) {
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  rows.forEach((r) => { r.score = r.wpm * (r.accuracy / 100); });
  return rows;
}

/* ============================================================================
   3. ANALYTICS (pure, unit-tested)
   ========================================================================== */

/** Trailing moving average; window is partial at the very start so the line
    spans the full range rather than starting blank. */
function movingAverage(vals, w) {
  return vals.map((_, i) => {
    const win = vals.slice(Math.max(0, i - w + 1), i + 1);
    return win.reduce((a, b) => a + b, 0) / win.length;
  });
}

/** Ordinary least-squares fit. Returns {slope, intercept}. */
function linReg(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const slope = den ? num / den : 0;
  return { slope, intercept: my - slope * mx };
}

/** Sorted unique ISO dates. */
const uniqueDates = (rows) => [...new Set(rows.map((r) => r.date))].sort();

/** Current streak = consecutive calendar days ending at the most recent entry. */
function trailingStreak(uISO) {
  if (!uISO.length) return 0;
  let s = 1;
  for (let i = uISO.length - 1; i > 0; i--) {
    if (dayNum(uISO[i]) - dayNum(uISO[i - 1]) === 1) s++;
    else break;
  }
  return s;
}

/** Date on which each streak threshold was FIRST reached (e.g. first 10-day run). */
function streakMilestoneDates(uISO, thresholds) {
  const hit = {};
  let run = 0;
  for (let i = 0; i < uISO.length; i++) {
    run = (i > 0 && dayNum(uISO[i]) - dayNum(uISO[i - 1]) === 1) ? run + 1 : 1;
    thresholds.forEach((t) => { if (run === t && !(t in hit)) hit[t] = uISO[i]; });
  }
  return hit;
}

/** Detect achieved milestones (WPM, accuracy, streaks), sorted chronologically. */
function detectMilestones(rows) {
  const out = [];
  CONFIG.WPM_MS.forEach((t) => {
    const r = rows.find((x) => x.wpm >= t);
    if (r) out.push({ date: r.date, label: `First ${t} WPM`, kind: 'wpm' });
  });
  CONFIG.ACC_MS.forEach((t) => {
    const r = rows.find((x) => x.accuracy >= t);
    if (r) out.push({ date: r.date, label: `First ${t}% accuracy`, kind: 'acc' });
  });
  const sm = streakMilestoneDates(uniqueDates(rows), CONFIG.STREAK_MS);
  Object.entries(sm).forEach(([t, d]) => out.push({ date: d, label: `${t}-day streak`, kind: 'streak' }));
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** Forecast days-to-goal via linear regression on WPM vs day index. */
function forecast(rows) {
  if (rows.length < CONFIG.MIN_FORECAST_POINTS) return { insufficient: true };

  const x0 = dayNum(rows[0].date);
  const xs = rows.map((r) => dayNum(r.date) - x0);
  const ys = rows.map((r) => r.wpm);
  const { slope, intercept } = linReg(xs, ys);

  const lastX  = xs[xs.length - 1];
  const curFit = intercept + slope * lastX;   // regression's "today" value
  const maxW   = Math.max(...ys);
  const lastISO = rows[rows.length - 1].date;

  const goals = CONFIG.WPM_TARGETS.map((t) => {
    if (maxW >= t)        return { target: t, achieved: true };
    if (slope <= 0.001)   return { target: t, flat: true };       // no upward trend
    const days = Math.max(0, Math.ceil((t - curFit) / slope));
    return { target: t, days, eta: addDaysISO(lastISO, days) };
  });

  return { slope, perWeek: slope * 7, goals };
}

/** Personal records: max of each metric plus the date it was achieved. */
function getRecords(rows) {
  const best = (key) => rows.reduce((b, r) => (r[key] > b[key] ? r : b), rows[0]);
  return {
    wpm:         best('wpm'),
    accuracy:    best('accuracy'),
    consistency: best('consistency'),
    score:       best('score'),
  };
}

/** Headline numbers for the hero cards. */
function getHeroStats(rows) {
  const uISO   = uniqueDates(rows);
  const last   = rows[rows.length - 1];
  const last7  = rows.slice(-CONFIG.MA_WINDOW).map((r) => r.wpm);
  const avg7   = last7.reduce((a, b) => a + b, 0) / last7.length;
  return {
    currentWpm: last.wpm,
    bestWpm:    Math.max(...rows.map((r) => r.wpm)),
    avg7:       avg7,
    deltaVsAvg: last.wpm - avg7,
    currentAcc: last.accuracy,
    streak:     trailingStreak(uISO),
    totalDays:  uISO.length,
  };
}

/* ============================================================================
   4. DOM HELPERS
   ========================================================================== */

const $  = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

/** Render the loading / error / empty status banner. */
function setStatus(kind, msg) {
  const box = $('#status');
  if (kind === 'hidden') { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.className = `status status--${kind}`;
  box.innerHTML = msg;
}

/* ============================================================================
   5. CHART THEME
   ========================================================================== */

function resolveTheme() {
  const css = getComputedStyle(document.documentElement);
  const get = (v, fb) => (css.getPropertyValue(v).trim() || fb);
  return {
    accent:     get('--accent', '#ff7a5c'),
    accentLine: get('--accent', '#ff7a5c'),
    accentSoft: get('--accent-soft', 'rgba(255,122,92,.14)'),
    text:       get('--text-dim', '#aab2c2'),
    mute:       get('--text-mute', '#7a8499'),
    grid:       get('--grid', 'rgba(255,255,255,.06)'),
    surface:    get('--surface', '#161a22'),
  };
}

/** Apply global Chart.js defaults so every chart matches the dark theme. */
function applyChartDefaults() {
  if (!state.chartLib) return;
  const t = state.theme;
  Chart.defaults.color = t.text;
  Chart.defaults.font.family =
    "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";
  Chart.defaults.font.size = 11;
  Chart.defaults.animation.duration = REDUCED_MOTION ? 0 : 550;
  Chart.defaults.plugins.legend.labels.boxWidth = 10;
  Chart.defaults.plugins.legend.labels.boxHeight = 10;
  Chart.defaults.plugins.legend.labels.usePointStyle = true;
  Chart.defaults.plugins.tooltip.backgroundColor = t.surface;
  Chart.defaults.plugins.tooltip.borderColor = t.grid;
  Chart.defaults.plugins.tooltip.borderWidth = 1;
  Chart.defaults.plugins.tooltip.titleColor = '#fff';
  Chart.defaults.plugins.tooltip.bodyColor = t.text;
  Chart.defaults.plugins.tooltip.padding = 10;
}

/** Shared cartesian scale config for the time-series charts. */
function trendScales(yHint) {
  const t = state.theme;
  return {
    x: {
      grid: { color: 'transparent' },
      ticks: { color: t.mute, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 },
    },
    y: {
      grid: { color: t.grid },
      ticks: { color: t.mute },
      ...(yHint || {}),
    },
  };
}

/* ============================================================================
   6. CHART BUILDERS
   ========================================================================== */

/**
 * Generic daily-vs-trend line chart (used for WPM, Typing Score, Accuracy,
 * Consistency). Daily values are muted dots + faint line (the noise); the
 * moving average is the bold accent line (the signal).
 */
function buildTrendChart(id, cfg) {
  const box = $('#' + id).parentElement;
  if (!state.chartLib) { box.innerHTML = chartUnavailable(); return; }

  const t = state.theme;
  const { labels, daily, ma, dailyLabel, maLabel, yHint, fmt, notes, pbIndex } = cfg;

  const datasets = [
    {
      label: dailyLabel,
      data: daily,
      borderColor: t.grid,
      backgroundColor: t.mute,
      pointBackgroundColor: t.mute,
      pointRadius: 2.4,
      pointHoverRadius: 4,
      borderWidth: 1,
      tension: 0.25,
      order: 2,
    },
    {
      label: maLabel,
      data: ma,
      borderColor: t.accentLine,
      backgroundColor: t.accentSoft,
      pointRadius: 0,
      pointHoverRadius: 0,
      borderWidth: 2.5,
      tension: 0.35,
      fill: true,
      order: 1,
    },
  ];

  // Optional personal-best marker (single highlighted point).
  if (Number.isInteger(pbIndex) && pbIndex >= 0) {
    const pb = daily.map((v, i) => (i === pbIndex ? v : null));
    datasets.push({
      label: 'Personal best',
      data: pb,
      borderColor: 'transparent',
      pointBackgroundColor: t.accent,
      pointBorderColor: '#fff',
      pointBorderWidth: 1.5,
      pointRadius: 5,
      pointHoverRadius: 6,
      showLine: false,
      order: 0,
    });
  }

  state.charts[id] = new Chart($('#' + id), {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: trendScales(yHint),
      plugins: {
        legend: { position: 'top', align: 'end', labels: { color: t.text } },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              if (ctx.parsed.y == null) return null;
              return `${ctx.dataset.label}: ${fmt(ctx.parsed.y)}`;
            },
            afterBody: (items) => {
              const i = items[0].dataIndex;
              return notes && notes[i] ? `“${notes[i]}”` : '';
            },
          },
        },
      },
    },
  });
}

/** Speed-vs-accuracy scatter: each day a dot, coloured by recency
    (old = muted, recent = accent) so the trajectory up-and-right is visible. */
function buildScatterChart(id, rows) {
  const box = $('#' + id).parentElement;
  if (!state.chartLib) { box.innerHTML = chartUnavailable(); return; }

  const t = state.theme;
  const n = rows.length;
  const points = rows.map((r) => ({ x: r.accuracy, y: r.wpm, date: r.date, notes: r.notes }));
  const colors = rows.map((_, i) => lerpColor(
    hexRgbString(t.mute), t.accent, n > 1 ? i / (n - 1) : 1));

  state.charts[id] = new Chart($('#' + id), {
    type: 'scatter',
    data: {
      datasets: [{
        label: 'Session',
        data: points,
        pointBackgroundColor: colors,
        pointBorderColor: 'transparent',
        pointRadius: 4.5,
        pointHoverRadius: 7,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          title: { display: true, text: 'Accuracy %', color: t.mute },
          grid: { color: t.grid }, ticks: { color: t.mute },
        },
        y: {
          title: { display: true, text: 'WPM', color: t.mute },
          grid: { color: t.grid }, ticks: { color: t.mute },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => fmtLong(items[0].raw.date),
            label: (ctx) => `WPM ${ctx.raw.y} · Acc ${ctx.raw.x}%`,
            afterLabel: (ctx) => (ctx.raw.notes ? `“${ctx.raw.notes}”` : ''),
          },
        },
      },
    },
  });
}

/** Some theme tokens may be stored as rgb()/named; normalise to hex for lerp. */
function hexRgbString(c) {
  if (c.startsWith('#')) return c;
  // Fall back to a neutral grey if the value isn't a hex string.
  return '#7a8499';
}

const chartUnavailable = () =>
  `<p class="chart-missing">Charts need the Chart.js library, which didn’t load.
   Check your network connection and reload.</p>`;

/* ============================================================================
   7. PRACTICE HEATMAP (GitHub-style)
   ========================================================================== */

function buildHeatmap(container, rows) {
  container.innerHTML = '';
  if (!rows.length) return;

  const byDate = new Map(rows.map((r) => [r.date, r]));
  const firstISO = rows[0].date;
  const lastISO  = rows[rows.length - 1].date;

  // Quartile thresholds (over practiced days) -> 4 intensity levels.
  const wpms = rows.map((r) => r.wpm).sort((a, b) => a - b);
  const q = (p) => wpms[Math.floor((wpms.length - 1) * p)];
  const t1 = q(0.25), t2 = q(0.5), t3 = q(0.75);
  const levelFor = (w) => (w >= t3 ? 4 : w >= t2 ? 3 : w >= t1 ? 2 : 1);

  // Grid spans from the Sunday on/before first date to the Saturday on/after last.
  const startDow = new Date(dayNum(firstISO) * 864e5).getUTCDay();   // 0=Sun
  const endDow   = new Date(dayNum(lastISO)  * 864e5).getUTCDay();
  const gridStart = dayNum(firstISO) - startDow;
  const gridEnd   = dayNum(lastISO) + (6 - endDow);
  const weeks = Math.round((gridEnd - gridStart + 1) / 7);

  const cell = 13, gap = 3;  // px; mirrored in CSS via inline vars
  container.style.setProperty('--hm-cell', cell + 'px');
  container.style.setProperty('--hm-gap', gap + 'px');

  // --- month labels row (aligned to week columns) ---
  const months = el('div', 'hm-months');
  months.style.gridTemplateColumns = `repeat(${weeks}, var(--hm-cell))`;
  let prevMonth = -1;
  for (let w = 0; w < weeks; w++) {
    const colISODay = gridStart + w * 7;
    const dt = new Date(colISODay * 864e5);
    const m = dt.getUTCMonth();
    const lab = el('span', 'hm-month');
    if (m !== prevMonth) { lab.textContent = MONTHS[m]; prevMonth = m; }
    months.appendChild(lab);
  }

  // --- weekday labels (Mon/Wed/Fri) ---
  const dayLabels = el('div', 'hm-daylabels');
  ['', 'Mon', '', 'Wed', '', 'Fri', ''].forEach((d) => {
    dayLabels.appendChild(el('span', 'hm-dlabel', d));
  });

  // --- day cells ---
  const grid = el('div', 'hm-grid');
  for (let d = gridStart; d <= gridEnd; d++) {
    const ms = d * 864e5;
    const dt = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    const iso = `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
    const rec = byDate.get(iso);
    const c = el('div', 'hm-cell');
    if (rec) {
      c.classList.add('lvl-' + levelFor(rec.wpm));
      c.title = `${fmtLong(iso)} · ${rec.wpm} wpm · ${rec.accuracy}% acc`;
    } else {
      c.classList.add('lvl-0');
      c.title = `${fmtLong(iso)} · no practice`;
    }
    grid.appendChild(c);
  }

  // --- legend ---
  const legend = el('div', 'hm-legend');
  legend.appendChild(el('span', 'hm-legend-label', 'less'));
  for (let l = 0; l <= 4; l++) legend.appendChild(el('span', 'hm-cell lvl-' + l));
  legend.appendChild(el('span', 'hm-legend-label', 'more'));

  // --- assemble (corner / months / weekday labels / grid) ---
  const inner = el('div', 'hm-inner');
  inner.appendChild(el('div', 'hm-corner'));
  inner.appendChild(months);
  inner.appendChild(dayLabels);
  inner.appendChild(grid);

  const scroll = el('div', 'hm-scroll');
  scroll.appendChild(inner);
  container.appendChild(scroll);
  container.appendChild(legend);
}

/* ============================================================================
   8. PANEL RENDERERS (hero / records / milestones / forecast / footer)
   ========================================================================== */

function renderHero(container, s) {
  container.innerHTML = '';

  const deltaTxt = (() => {
    const d = round1(s.deltaVsAvg);
    if (Math.abs(d) < 0.05) return `<span class="delta delta--flat">±0 vs 7-day avg</span>`;
    const up = d > 0;
    return `<span class="delta ${up ? 'delta--up' : 'delta--down'}">
              ${up ? '▲' : '▼'} ${Math.abs(d)} vs 7-day avg</span>`;
  })();

  // Featured card: current WPM with the blinking-caret signature.
  const featured = el('div', 'stat stat--feature');
  featured.innerHTML = `
    <span class="stat-label">current wpm</span>
    <span class="stat-value stat-value--xl">${s.currentWpm}<span class="caret" aria-hidden="true"></span></span>
    ${deltaTxt}`;
  container.appendChild(featured);

  const cards = [
    { label: 'best wpm',        value: s.bestWpm,            sub: 'all-time peak' },
    { label: '7-day avg wpm',   value: round1(s.avg7),       sub: 'recent form' },
    { label: 'current accuracy',value: s.currentAcc + '%',   sub: 'latest session' },
    { label: 'practice streak', value: s.streak,             sub: s.streak === 1 ? 'day' : 'days in a row' },
    { label: 'days logged',     value: s.totalDays,          sub: 'total sessions' },
  ];
  cards.forEach((c) => {
    const n = el('div', 'stat');
    n.innerHTML = `
      <span class="stat-label">${c.label}</span>
      <span class="stat-value">${c.value}</span>
      <span class="stat-sub">${c.sub}</span>`;
    container.appendChild(n);
  });
}

function renderRecords(container, rec) {
  const rows = [
    { label: 'Highest WPM',         val: rec.wpm.wpm,                 date: rec.wpm.date },
    { label: 'Highest accuracy',    val: rec.accuracy.accuracy + '%', date: rec.accuracy.date },
    { label: 'Highest consistency', val: rec.consistency.consistency, date: rec.consistency.date },
    { label: 'Highest typing score',val: round1(rec.score.score),     date: rec.score.date },
  ];
  container.innerHTML = rows.map((r) => `
    <div class="record">
      <span class="record-label">${r.label}</span>
      <span class="record-val">${r.val}</span>
      <span class="record-date">${fmtLong(r.date)}</span>
    </div>`).join('');
}

function renderMilestones(container, items) {
  if (!items.length) {
    container.innerHTML = `<p class="muted">No milestones yet — they’ll appear here as you hit
      your first 70/80/90 WPM, accuracy targets, and streaks.</p>`;
    return;
  }
  container.innerHTML = items.map((m) => `
    <div class="milestone milestone--${m.kind}">
      <span class="milestone-dot" aria-hidden="true"></span>
      <span class="milestone-label">${m.label}</span>
      <span class="milestone-date">${fmtLong(m.date)}</span>
    </div>`).join('');
}

function renderForecast(container, f) {
  if (f.insufficient) {
    container.innerHTML = `<p class="muted">Keep logging — forecasts need at least
      ${CONFIG.MIN_FORECAST_POINTS} sessions before the trend is meaningful.</p>`;
    return;
  }

  const rate = round1(f.perWeek);
  const rateLine = `
    <div class="forecast-rate">
      <span class="stat-value stat-value--lg">${rate > 0 ? '+' : ''}${rate}</span>
      <span class="forecast-rate-unit">wpm / week</span>
      <span class="stat-sub">current improvement rate</span>
    </div>`;

  const goals = f.goals.map((g) => {
    let right;
    if (g.achieved)   right = `<span class="goal-done">achieved ✓</span>`;
    else if (g.flat)  right = `<span class="muted">need an upward trend</span>`;
    else              right = `<span class="goal-eta">~${g.days} days<span class="goal-date">${fmtShort(g.eta)}</span></span>`;
    return `
      <div class="goal">
        <span class="goal-target">${g.target} WPM</span>
        ${right}
      </div>`;
  }).join('');

  container.innerHTML = rateLine + `<div class="goals">${goals}</div>`;
}

function renderFooter(container, rows) {
  const last = rows[rows.length - 1];
  container.innerHTML = `
    <span>${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}</span>
    <span class="dot">·</span>
    <span>last updated ${fmtLong(last.date)}</span>
    <span class="dot">·</span>
    <span class="footer-mark">TypeTrack</span>`;
}

/* ============================================================================
   9. CHART RANGE FILTER
   ========================================================================== */

/** Return only rows within the selected range, relative to the latest entry. */
function filterByRange(rows, range) {
  if (range === 'all' || !rows.length) return rows;
  const lastDay = dayNum(rows[rows.length - 1].date);
  const cutoff = lastDay - (Number(range) - 1);
  return rows.filter((r) => dayNum(r.date) >= cutoff);
}

/** Destroy any existing chart instances (needed before rebuilding on filter change). */
function destroyCharts() {
  Object.values(state.charts).forEach((c) => c && c.destroy());
  state.charts = {};
}

/** (Re)build the five trend/scatter charts for the given range. Hero stats,
    records, milestones, forecast and heatmap intentionally always reflect
    ALL data — the range filter only zooms the trend charts. */
function renderCharts(range) {
  destroyCharts();
  const rows = filterByRange(state.rows, range);
  if (!rows.length) return;

  const labels = rows.map((r) => fmtShort(r.date));
  const notes  = rows.map((r) => r.notes);
  const wpm    = rows.map((r) => r.wpm);
  const score  = rows.map((r) => round1(r.score));
  const acc    = rows.map((r) => r.accuracy);
  const cons   = rows.map((r) => (r.consistency == null ? null : r.consistency));

  // Personal-best index within the visible window (for the WPM marker).
  const pbIndex = wpm.indexOf(Math.max(...wpm));

  buildTrendChart('wpmChart', {
    labels, daily: wpm, ma: movingAverage(wpm, CONFIG.MA_WINDOW),
    dailyLabel: 'Daily WPM', maLabel: `${CONFIG.MA_WINDOW}-day average`,
    yHint: {}, fmt: (v) => Math.round(v) + ' wpm', notes, pbIndex,
  });

  buildTrendChart('scoreChart', {
    labels, daily: score, ma: movingAverage(score, CONFIG.MA_WINDOW),
    dailyLabel: 'Daily score', maLabel: `${CONFIG.MA_WINDOW}-day average`,
    yHint: {}, fmt: (v) => round1(v), notes,
  });

  buildTrendChart('accChart', {
    labels, daily: acc, ma: movingAverage(acc, CONFIG.MA_WINDOW),
    dailyLabel: 'Daily accuracy', maLabel: `${CONFIG.MA_WINDOW}-day average`,
    yHint: { suggestedMax: 100 }, fmt: (v) => round1(v) + '%', notes,
  });

  buildTrendChart('consChart', {
    labels, daily: cons, ma: movingAverage(cons.map((v) => v || 0), CONFIG.MA_WINDOW),
    dailyLabel: 'Daily consistency', maLabel: `${CONFIG.MA_WINDOW}-day average`,
    yHint: { suggestedMax: 100 }, fmt: (v) => Math.round(v), notes,
  });

  buildScatterChart('scatterChart', rows);
}

/** Wire up the range toggle buttons. */
function initRangeControls() {
  const buttons = document.querySelectorAll('.range button');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      buttons.forEach((b) => { b.classList.remove('is-active'); b.setAttribute('aria-pressed', 'false'); });
      btn.classList.add('is-active');
      btn.setAttribute('aria-pressed', 'true');
      renderCharts(btn.dataset.range);
    });
  });
}

/* ============================================================================
   10. INIT
   ========================================================================== */

async function init() {
  state.theme = resolveTheme();
  state.chartLib = (typeof Chart !== 'undefined');
  applyChartDefaults();

  setStatus('loading', 'Loading your typing data…');

  let text;
  try {
    const res = await fetch(CONFIG.CSV_PATH, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (err) {
    setStatus('error', `
      <strong>Couldn’t load ${CONFIG.CSV_PATH}.</strong>
      If you opened <code>index.html</code> straight from your disk, the browser
      blocks reading local files — run a local server
      (<code>python3 -m http.server</code>) or push to GitHub Pages.
      <span class="muted">(${err.message})</span>`);
    return;
  }

  state.rows = prepData(parseCSV(text));

  // Empty state — an invitation to act, not just a blank screen.
  if (!state.rows.length) {
    setStatus('empty', `
      <strong>No data yet.</strong>
      Add rows to <code>${CONFIG.CSV_PATH}</code> — one line per day
      (<code>date,wpm,raw,accuracy,consistency,test_duration,notes</code>) —
      then reload to watch your progress build.`);
    $('#dashboard').hidden = true;
    return;
  }

  setStatus('hidden');
  $('#dashboard').hidden = false;

  // Everything below uses the FULL dataset.
  renderHero($('#heroStats'), getHeroStats(state.rows));
  renderRecords($('#records'), getRecords(state.rows));
  renderMilestones($('#milestones'), detectMilestones(state.rows));
  renderForecast($('#forecast'), forecast(state.rows));
  buildHeatmap($('#heatmap'), state.rows);
  renderFooter($('#footer'), state.rows);

  // Charts respond to the range toggle; set the default active button.
  initRangeControls();
  const def = document.querySelector(`.range button[data-range="${CONFIG.DEFAULT_RANGE}"]`);
  if (def) { def.classList.add('is-active'); def.setAttribute('aria-pressed', 'true'); }
  renderCharts(CONFIG.DEFAULT_RANGE);
}

document.addEventListener('DOMContentLoaded', init);
