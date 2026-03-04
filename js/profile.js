/**
 * Profile & history management for SingWell.
 *
 * Persists exercise results in localStorage and provides rendering
 * for the performance-over-time graph and history list.
 */

const STORAGE_KEY = 'singwell_history';

const EXERCISE_COLORS = {
  'sustained-tone': '#d4af37',
  'five-tone-scale': '#a855f7',
  'major-arpeggio': '#38bdf8',
  'solfege-ladder': '#818cf8',
  'minor-scale': '#e879f9',
  'interval-jumps': '#34d399',
  'octave-siren': '#f472b6',
  'triad-pattern': '#2dd4bf',
  'messa-di-voce': '#fb923c',
  'vowel-clarity': '#f59e0b',
  'vowel-slides': '#06b6d4',
  'resonance-placement': '#ec4899',
  'range-finder': '#a3e635',
};

export function saveExerciseResult({
  exerciseId,
  exerciseName,
  voiceType,
  score,
  rating,
}) {
  const history = getExerciseHistory();
  history.push({
    exerciseId,
    exerciseName,
    voiceType,
    score: Math.round(score * 10) / 10,
    rating,
    date: new Date().toISOString(),
  });
  // Keep last 200 entries
  if (history.length > 200) {
    history.splice(0, history.length - 200);
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
}

export function getExerciseHistory() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

const hiddenExercises = new Set();

export function getExerciseColor(exerciseId) {
  return EXERCISE_COLORS[exerciseId] || '#888';
}

export function deleteHistoryEntry(dateStr) {
  const history = getExerciseHistory();
  const filtered = history.filter((e) => e.date !== dateStr);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
}

/**
 * Render the performance-over-time line chart on a canvas.
 */
export function renderPerformanceGraph(canvas, { timescale = 'all' } = {}) {
  let history = getExerciseHistory();

  if (timescale !== 'all') {
    const now = Date.now();
    let cutoff;
    switch (timescale) {
      case '1h':
        cutoff = now - 3600000;
        break;
      case 'today': {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        cutoff = d.getTime();
        break;
      }
      case 'week':
        cutoff = now - 7 * 86400000;
        break;
      default:
        cutoff = 0;
    }
    history = history.filter((e) => new Date(e.date).getTime() >= cutoff);
  }
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;

  const marginLeft = 50;
  const marginRight = 20;
  const marginTop = 20;
  const marginBottom = 40;
  const plotWidth = width - marginLeft - marginRight;
  const plotHeight = height - marginTop - marginBottom;

  // Background
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, 0, width, height);

  if (history.length === 0) {
    ctx.fillStyle = '#666';
    ctx.font = '14px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(
      'Complete some exercises to see your progress here',
      width / 2,
      height / 2
    );
    return;
  }

  // Y-axis grid lines (0%, 25%, 50%, 75%, 100%)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;

  for (let pct = 0; pct <= 100; pct += 25) {
    const y = marginTop + plotHeight * (1 - pct / 100);
    ctx.beginPath();
    ctx.moveTo(marginLeft, y);
    ctx.lineTo(width - marginRight, y);
    ctx.stroke();

    ctx.fillStyle = '#666';
    ctx.font = '11px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`${pct}%`, marginLeft - 8, y + 4);
  }

  // Group by exercise type
  const grouped = {};
  for (const entry of history) {
    if (!grouped[entry.exerciseId]) {
      grouped[entry.exerciseId] = [];
    }
    grouped[entry.exerciseId].push(entry);
  }

  // Global time range
  const dates = history.map((e) => new Date(e.date).getTime());
  const minDate = Math.min(...dates);
  const maxDate = Math.max(...dates);
  const dateRange = maxDate - minDate || 1;
  const isSinglePoint = history.length === 1 || dateRange < 1000;

  // Draw lines for each exercise type
  for (const [exerciseId, entries] of Object.entries(grouped)) {
    if (hiddenExercises.has(exerciseId)) continue;
    const color = EXERCISE_COLORS[exerciseId] || '#888';
    const sorted = [...entries].sort(
      (a, b) => new Date(a.date) - new Date(b.date)
    );

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();

    for (let i = 0; i < sorted.length; i++) {
      const dateMs = new Date(sorted[i].date).getTime();
      const x = isSinglePoint
        ? marginLeft + plotWidth / 2
        : marginLeft + ((dateMs - minDate) / dateRange) * plotWidth;
      const y = marginTop + plotHeight * (1 - sorted[i].score / 100);

      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Draw dots
    ctx.fillStyle = color;
    for (const entry of sorted) {
      const dateMs = new Date(entry.date).getTime();
      const x = isSinglePoint
        ? marginLeft + plotWidth / 2
        : marginLeft + ((dateMs - minDate) / dateRange) * plotWidth;
      const y = marginTop + plotHeight * (1 - entry.score / 100);
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // X-axis date labels
  const rangeHours = dateRange / (1000 * 60 * 60);
  const useTime = rangeHours < 24;

  function formatLabel(timestamp) {
    const d = new Date(timestamp);
    if (useTime) {
      return d.toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
      });
    }
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }

  ctx.fillStyle = '#666';
  ctx.font = '10px monospace';
  ctx.textAlign = 'center';

  if (isSinglePoint) {
    ctx.fillText(
      formatLabel(dates[0]),
      marginLeft + plotWidth / 2,
      height - marginBottom + 18
    );
  } else {
    const labelCount = Math.min(5, history.length);
    for (let i = 0; i < labelCount; i++) {
      const t = minDate + (dateRange * i) / (labelCount - 1);
      const x = marginLeft + (plotWidth * i) / (labelCount - 1);
      ctx.fillText(formatLabel(t), x, height - marginBottom + 18);
    }
  }
}

/**
 * Render the legend for the performance graph as HTML.
 */
export function renderPerformanceLegend(container, { onToggle } = {}) {
  const history = getExerciseHistory();
  container.innerHTML = '';

  const seen = new Set();
  for (const entry of history) {
    if (seen.has(entry.exerciseId)) continue;
    seen.add(entry.exerciseId);

    const item = document.createElement('div');
    item.className = 'legend-item';
    if (hiddenExercises.has(entry.exerciseId)) {
      item.classList.add('legend-hidden');
    }
    const color = EXERCISE_COLORS[entry.exerciseId] || '#888';
    item.innerHTML = `
      <span class="legend-color" style="background: ${color}"></span>
      <span class="legend-label">${entry.exerciseName}</span>
    `;
    const exerciseId = entry.exerciseId;
    item.addEventListener('click', () => {
      if (hiddenExercises.has(exerciseId)) {
        hiddenExercises.delete(exerciseId);
      } else {
        hiddenExercises.add(exerciseId);
      }
      item.classList.toggle('legend-hidden');
      if (onToggle) onToggle();
    });
    container.appendChild(item);
  }
}

/**
 * Render the history list as DOM elements.
 * @param {HTMLElement} container
 * @param {{ onDelete?: () => void }} options
 */
export function renderHistoryList(container, { onDelete } = {}) {
  const history = getExerciseHistory();
  container.innerHTML = '';

  if (history.length === 0) {
    container.innerHTML =
      '<p class="history-empty">No exercises completed yet. Go warm up!</p>';
    return;
  }

  const recent = [...history].reverse().slice(0, 50);

  for (const entry of recent) {
    const row = document.createElement('div');
    row.className = 'history-row';

    const date = new Date(entry.date);
    const dateStr = date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    const timeStr = date.toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });

    const color = EXERCISE_COLORS[entry.exerciseId] || '#888';

    let ratingClass = 'rating-needs_work';
    if (entry.rating === 'excellent') ratingClass = 'rating-excellent';
    else if (entry.rating === 'good') ratingClass = 'rating-good';
    else if (entry.rating === 'fair') ratingClass = 'rating-fair';

    row.innerHTML = `
      <span class="history-color" style="background: ${color}"></span>
      <span class="history-exercise">${entry.exerciseName}</span>
      <span class="history-score ${ratingClass}">${Math.round(entry.score)}%</span>
      <span class="history-date">${dateStr} ${timeStr}</span>
    `;

    if (onDelete) {
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'history-delete-btn';
      deleteBtn.textContent = '\u00d7';
      deleteBtn.title = 'Delete this session';
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteHistoryEntry(entry.date);
        onDelete();
      });
      row.appendChild(deleteBtn);
    }

    container.appendChild(row);
  }
}

/**
 * Calculate and render practice streak info.
 */
export function renderStreakInfo() {
  const history = getExerciseHistory();

  // Total sessions
  document.getElementById('total-sessions').textContent =
    `${history.length} total sessions`;

  // Today's sessions
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayCount = history.filter(
    (e) => new Date(e.date).getTime() >= todayStart.getTime()
  ).length;
  document.getElementById('today-sessions').textContent =
    `${todayCount} today`;

  // Calculate streak: consecutive days with at least one session
  if (history.length === 0) {
    document.getElementById('streak-count').textContent = '0';
    return;
  }

  // Get unique practice dates (YYYY-MM-DD)
  const practiceDates = new Set();
  for (const entry of history) {
    const d = new Date(entry.date);
    practiceDates.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
  }

  // Count streak backwards from today
  let streak = 0;
  const now = new Date();
  const checkDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  while (true) {
    const key = `${checkDate.getFullYear()}-${checkDate.getMonth()}-${checkDate.getDate()}`;
    if (practiceDates.has(key)) {
      streak++;
      checkDate.setDate(checkDate.getDate() - 1);
    } else {
      break;
    }
  }

  document.getElementById('streak-count').textContent = String(streak);
}

/**
 * Render running averages per exercise across multiple timescales.
 */
const AVERAGES_TIMESCALES = [
  { key: '1h', label: '1h', ms: 3600000 },
  { key: 'today', label: 'Today', today: true },
  { key: 'week', label: 'Week', ms: 7 * 86400000 },
  { key: 'month', label: 'Month', ms: 30 * 86400000 },
  { key: 'year', label: 'Year', ms: 365 * 86400000 },
  { key: 'all', label: 'All', ms: Infinity },
];
export function renderRunningAverages(container) {
  const history = getExerciseHistory();
  container.innerHTML = '';

  if (history.length === 0) {
    container.innerHTML =
      '<p class="history-empty">No data yet</p>';
    return;
  }

  // Collect unique exercises in first-seen order
  const exerciseIds = [];
  const exerciseNames = {};
  for (const entry of history) {
    if (!exerciseNames[entry.exerciseId]) {
      exerciseIds.push(entry.exerciseId);
      exerciseNames[entry.exerciseId] = entry.exerciseName;
    }
  }

  const now = Date.now();

  const table = document.createElement('div');
  table.className = 'averages-table';

  // Header row
  const header = document.createElement('div');
  header.className = 'averages-row averages-header';
  header.innerHTML =
    '<span class="avg-exercise"></span>' +
    AVERAGES_TIMESCALES.map(
      (t) => `<span class="avg-cell">${t.label}</span>`
    ).join('');
  table.appendChild(header);

  // Data rows
  for (const exId of exerciseIds) {
    const color = EXERCISE_COLORS[exId] || '#888';
    const row = document.createElement('div');
    row.className = 'averages-row';

    let html = `<span class="avg-exercise" style="color: ${color}">${exerciseNames[exId]}</span>`;

    for (const ts of AVERAGES_TIMESCALES) {
      let cutoff;
      if (ts.key === 'all') {
        cutoff = 0;
      } else if (ts.today) {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        cutoff = d.getTime();
      } else {
        cutoff = now - ts.ms;
      }

      const matching = history.filter(
        (e) => e.exerciseId === exId && new Date(e.date).getTime() >= cutoff
      );

      if (matching.length > 0) {
        const avg = Math.round(
          matching.reduce((a, b) => a + b.score, 0) / matching.length
        );
        let avgClass = 'avg-needs-work';
        if (avg >= 80) avgClass = 'avg-excellent';
        else if (avg >= 60) avgClass = 'avg-good';
        else if (avg >= 40) avgClass = 'avg-fair';
        html += `<span class="avg-cell ${avgClass}">${avg}%</span>`;
      } else {
        html += `<span class="avg-cell avg-no-data">\u2014</span>`;
      }
    }

    row.innerHTML = html;
    table.appendChild(row);
  }

  container.appendChild(table);

  // Trend indicators per exercise
  const trendContainer = document.createElement('div');
  trendContainer.className = 'trend-indicators';

  for (const exId of exerciseIds) {
    const entries = history.filter((e) => e.exerciseId === exId);
    if (entries.length < 3) continue;

    const sorted = [...entries].sort((a, b) => new Date(a.date) - new Date(b.date));
    const recent = sorted.slice(-5);
    const older = sorted.slice(-10, -5);

    if (older.length === 0 && recent.length < 3) continue;

    const recentAvg = recent.reduce((s, e) => s + e.score, 0) / recent.length;

    let trend, trendClass;
    if (older.length > 0) {
      const olderAvg = older.reduce((s, e) => s + e.score, 0) / older.length;
      const diff = recentAvg - olderAvg;
      if (diff > 5) { trend = '↑ improving'; trendClass = 'trend-up'; }
      else if (diff < -5) { trend = '↓ declining'; trendClass = 'trend-down'; }
      else { trend = '→ stable'; trendClass = 'trend-stable'; }
    } else {
      // Only recent data — compare first vs last
      const first = recent[0].score;
      const last = recent[recent.length - 1].score;
      const diff = last - first;
      if (diff > 5) { trend = '↑ improving'; trendClass = 'trend-up'; }
      else if (diff < -5) { trend = '↓ declining'; trendClass = 'trend-down'; }
      else { trend = '→ stable'; trendClass = 'trend-stable'; }
    }

    const color = EXERCISE_COLORS[exId] || '#888';
    const item = document.createElement('div');
    item.className = 'trend-item';
    item.innerHTML = `
      <span class="trend-exercise" style="color: ${color}">${exerciseNames[exId]}</span>
      <span class="trend-direction ${trendClass}">${trend}</span>
    `;
    trendContainer.appendChild(item);
  }

  if (trendContainer.children.length > 0) {
    const trendHeader = document.createElement('h4');
    trendHeader.className = 'trend-header';
    trendHeader.textContent = 'Trends (last 5 vs previous 5)';
    container.appendChild(trendHeader);
    container.appendChild(trendContainer);
  }
}
