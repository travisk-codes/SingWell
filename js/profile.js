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
  'octave-siren': '#f472b6',
  'triad-pattern': '#2dd4bf',
  'messa-di-voce': '#fb923c',
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

export function getExerciseColor(exerciseId) {
  return EXERCISE_COLORS[exerciseId] || '#888';
}

/**
 * Render the performance-over-time line chart on a canvas.
 */
export function renderPerformanceGraph(canvas) {
  const history = getExerciseHistory();
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
  ctx.fillStyle = '#1a1a2e';
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
export function renderPerformanceLegend(container) {
  const history = getExerciseHistory();
  container.innerHTML = '';

  const seen = new Set();
  for (const entry of history) {
    if (seen.has(entry.exerciseId)) continue;
    seen.add(entry.exerciseId);

    const item = document.createElement('div');
    item.className = 'legend-item';
    const color = EXERCISE_COLORS[entry.exerciseId] || '#888';
    item.innerHTML = `
      <span class="legend-color" style="background: ${color}"></span>
      <span class="legend-label">${entry.exerciseName}</span>
    `;
    container.appendChild(item);
  }
}

/**
 * Render the history list as DOM elements.
 */
export function renderHistoryList(container) {
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
    container.appendChild(row);
  }
}
