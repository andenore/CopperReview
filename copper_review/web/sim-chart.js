/* The interactive chart of the simulation view: panels of curves on one shared x axis, drawn on a
 * canvas (a base layer for grid, limits and curves, an overlay for the cursor). Ctrl+wheel zooms
 * under the pointer (with Shift: the value axis of that panel), dragging draws a zoom box, right- or
 * middle-drag (or Shift-drag) pans, double-click resets. Hovering reads the nearest curve; a click
 * pins cursor A, the next one cursor B, and the readout gives their difference. Colours come from
 * the page's CSS custom properties, so the chart follows the light and dark themes. */
import {unitSystem, unitFor, significant, scientific, formatQuantity} from './sim.js';
const tickNum = (v, d) => v !== 0 && (Math.abs(v) < 1e-3 || Math.abs(v) >= 1e5) ? scientific(v, 3) : significant(v, d);
/** A tick value with as many decimals as its tick step needs, so neighbouring ticks never read alike. */
const tickText = (v, step) => { if (v !== 0 && (Math.abs(v) < 1e-3 || Math.abs(v) >= 1e5)) return scientific(v, 4); const dec = Math.max(0, Math.min(12, Math.ceil(-Math.log10(step) - 1e-9))); const t = v.toFixed(dec); return /^-0\.?0*$/.test(t) ? t.slice(1) : t; };

const LEFT = 64, RIGHT = 14, TITLE = 20, GAP = 16, BOTTOM = 40, MIN_W = 240;
const charts = new Set();
let themeWatch = null;
function watchTheme() {
  if (themeWatch || typeof MutationObserver === 'undefined') return;
  themeWatch = new MutationObserver(() => { for (const c of charts) c.redraw(); });
  themeWatch.observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme']});
}
function palette(host) {
  const css = getComputedStyle(host), v = name => css.getPropertyValue(name).trim();
  return {bg: v('--panel') || '#fff', text: v('--text') || '#1c2427', muted: v('--muted') || '#5c6b72', grid: v('--hairline') || '#e7ecee', major: v('--border') || '#d6dde0',
    frame: v('--quiet') || '#9aa8ae', limit: v('--sim-limit') || '#111827', fail: v('--sim-fail') || '#c8321a', ref: v('--sim-ref') || '#7b8794', floor: v('--sim-floor') || '#9aa8ae33',
    cursor: v('--sim-cursor') || '#b0592a', box: v('--sim-box') || '#16806a33', steps: Array.from({length: 8}, (_, i) => v(`--sim-step-${i}`) || '#1d5fa8'),
    ramp: [v('--sim-ramp-0') || '#2c1b5e', v('--sim-ramp-1') || '#3b528b', v('--sim-ramp-2') || '#21918c', v('--sim-ramp-3') || '#3fa356', v('--sim-ramp-4') || '#a89800']};
}
const hex = c => { const m = /^#([0-9a-f]{6})/i.exec(c); return m ? [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)) : [128, 128, 128]; };
function rampColor(stops, t) {
  const p = Math.min(1, Math.max(0, t)) * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(p)), f = p - i, a = hex(stops[i]), b = hex(stops[i + 1]);
  return `rgb(${a.map((x, k) => Math.round(x + (b[k] - x) * f)).join(',')})`;
}
/** Index of the first element of a sorted array not below x. */
function lower(xs, x) { let lo = 0, hi = xs.length; while (lo < hi) { const m = (lo + hi) >> 1; if (xs[m] < x) lo = m + 1; else hi = m; } return lo; }
function niceStep(span, target, degrees) {
  if (degrees && span >= 30) return [15, 30, 45, 90, 180, 360].find(s => span / s <= target + 0.5) || 360;
  const raw = span / target, mag = 10 ** Math.floor(Math.log10(raw));
  return ([1, 2, 2.5, 5, 10].find(s => span / (s * mag) <= target + 0.5) || 10) * mag;
}
function linearTicks(lo, hi, target, degrees) {
  const step = niceStep(Math.max(hi - lo, 1e-300), target, degrees), out = [];
  for (let k = Math.ceil(lo / step - 1e-9); k <= Math.floor(hi / step + 1e-9) && out.length < 60; k++) out.push(Math.abs(k * step) < step * 1e-9 ? 0 : k * step);
  return {ticks: out, step};
}
/** Ticks of a log axis given in decades (log10 values): decades, with 2 and 5 between when there is room. */
function logTicks(lo, hi, room) {
  const decades = hi - lo, out = [];
  if (decades < 0.6) { const {ticks, step} = linearTicks(10 ** lo, 10 ** hi, Math.min(room, 6)); return ticks.filter(t => t > 0).map(t => ({at: Math.log10(t), major: false, value: t, label: true, step})); }
  const every = Math.max(1, Math.ceil(decades / Math.max(1, room)));
  // Few decades: every mantissa as a grid line, a few labelled; many: decades only, so the grid stays calm.
  const minors = decades <= 1.5 ? [2, 3, 4, 5, 6, 7, 8, 9] : decades <= 5 ? [2, 5] : [];
  const labelled = decades <= 1.5 ? [2, 3, 5] : decades <= Math.min(3, room * 0.4) ? [2, 5] : [];
  for (let d = Math.floor(lo); d <= Math.ceil(hi); d++) {
    if (d >= lo - 1e-9 && d <= hi + 1e-9) out.push({at: d, major: true, value: 10 ** d, label: d % every === 0});
    for (const m of minors) { const at = d + Math.log10(m); if (at > lo && at < hi) out.push({at, major: false, value: m * 10 ** d, label: labelled.includes(m)}); }
  }
  return out;
}
/** The text of one axis value: a value in `system` units, or a plain number. */
function valueText(v, axis, digits = 4) {
  if (axis.harmonics) return significant(v, 3);
  if (axis.plain) return `${significant(v, digits)}${axis.plain === true ? '' : ` ${axis.plain}`}`;
  return formatQuantity(v, axis.units, axis.dimension, {digits});
}

/**
 * Draw `figure` into `host`. `figure.x` describes the shared axis ({name, units, dimension, scale,
 * logDefault, canLog, harmonics, periods}); each panel has a title, units, series [{step, x, y}],
 * marks (limit lines and windows), refs (reference lines) and optionally a floor. `opts.style(step)`
 * gives {color, dash, label}; `opts.hidden` is the set of steps not drawn.
 */
export function createChart(host, figure, opts) {
  const wrap = document.createElement('div'); wrap.className = 'sim-canvas-wrap'; wrap.tabIndex = 0;
  wrap.setAttribute('role', 'img'); wrap.setAttribute('aria-label', `${figure.panels.map(p => p.title).join(', ')} against ${figure.x.label || figure.x.name}. Ctrl+wheel zooms, drag to zoom a box, double-click resets.`);
  const base = document.createElement('canvas'), over = document.createElement('canvas'); over.className = 'sim-overlay';
  const readout = document.createElement('div'); readout.className = 'sim-readout'; readout.setAttribute('aria-live', 'polite');
  wrap.append(base, over); host.append(wrap, readout);
  const state = {logX: !!figure.x.logDefault, logY: figure.panels.map(p => !!p.logY), xRange: null, yRange: figure.panels.map(() => null), hidden: opts.hidden || new Set(),
    hover: null, cursors: [], drag: null, width: 0, layout: null};
  let colors = palette(host), frame = 0, overFrame = 0;
  const style = step => { const s = opts.style(step); return {color: s.color?.ramp !== undefined ? rampColor(colors.ramp, s.color.ramp) : colors.steps[(s.color?.palette ?? step) % 8], dash: s.dash || [], label: s.label}; };
  const tx = v => state.logX ? (v > 0 ? Math.log10(v) : NaN) : v;
  const ty = (p, v) => state.logY[p] ? (v > 0 ? Math.log10(v) : NaN) : v;
  const untx = v => state.logX ? 10 ** v : v;
  const unty = (p, v) => state.logY[p] ? 10 ** v : v;
  const visible = panel => panel.series.filter(s => s.y && s.x && !state.hidden.has(s.step));
  function fullX() {
    let lo = Infinity, hi = -Infinity;
    for (const panel of figure.panels) for (const s of panel.series) { if (!s.x || !s.y) continue; for (const x of s.x) { const t = tx(x); if (Number.isFinite(t)) { if (t < lo) lo = t; if (t > hi) hi = t; } } }
    if (!(hi > lo)) { lo = Number.isFinite(lo) ? lo - 1 : 0; hi = lo + 2; }
    return [lo, hi];
  }
  /** The value range of a panel over the shown x range: data, then limits and references when they do not squash it. */
  function autoY(p) {
    const panel = figure.panels[p], [x0, x1] = state.xRange; let lo = Infinity, hi = -Infinity;
    for (const s of visible(panel)) {
      const i0 = Math.max(0, lower(s.x, untx(x0)) - 1), i1 = Math.min(s.x.length, lower(s.x, untx(x1)) + 1);
      for (let i = i0; i < i1; i++) { const v = ty(p, s.y[i]); if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
    }
    if (panel.yMin !== undefined && Number.isFinite(lo)) lo = Math.max(lo, ty(p, panel.yMin));
    if (!Number.isFinite(lo)) return [0, 1];
    const extra = [...panel.marks.flatMap(m => m.kind === 'line' ? [m.value] : [m.min, m.max]).filter(v => v !== null), ...panel.refs.map(r => r.value), ...(panel.floor ? [panel.floor.value] : [])].map(v => ty(p, v)).filter(Number.isFinite);
    const elo = Math.min(lo, ...extra), ehi = Math.max(hi, ...extra);
    if (ehi > elo && (hi - lo) / (ehi - elo) >= 0.25) { lo = elo; hi = ehi; }
    // A log axis spans at least a decade, so a nearly flat density reads flat rather than as a slope.
    if (state.logY[p] && hi - lo < 1) { const c = (hi + lo) / 2; lo = c - 0.5; hi = c + 0.5; }
    if (hi - lo < Math.abs(hi) * 1e-9 || hi === lo) { const d = state.logY[p] ? 0.5 : Math.abs(hi) * 0.05 || 1; lo -= d; hi += d; }
    const pad = (hi - lo) * 0.06; return [lo - pad, hi + pad];
  }
  function layout() {
    const width = Math.max(MIN_W, wrap.clientWidth || host.clientWidth || 600), plotW = width - LEFT - RIGHT, n = figure.panels.length;
    const ph = width < 520 ? 150 : n > 6 ? 130 : n > 3 ? 160 : 200;
    let y = 4; const panels = figure.panels.map(() => { const r = {top: y + TITLE, height: ph}; y += TITLE + ph + GAP; return r; });
    return {width, plotW, panels, height: y - GAP + BOTTOM};
  }
  const px = x => LEFT + (x - state.xRange[0]) / (state.xRange[1] - state.xRange[0]) * state.layout.plotW;
  const pxInv = X => state.xRange[0] + (X - LEFT) / state.layout.plotW * (state.xRange[1] - state.xRange[0]);
  const py = (p, v) => { const r = state.layout.panels[p], [lo, hi] = state.yNow[p]; return r.top + r.height - (v - lo) / (hi - lo) * r.height; };
  const pyInv = (p, Y) => { const r = state.layout.panels[p], [lo, hi] = state.yNow[p]; return lo + (r.top + r.height - Y) / r.height * (hi - lo); };
  function size(canvas, w, h) { const dpr = devicePixelRatio || 1; if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); } canvas.style.width = `${w}px`; canvas.style.height = `${h}px`; const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); return ctx; }
  /** The axis description used for tick labels. */
  const xAxis = () => figure.x.harmonics ? {harmonics: true} : figure.x.periods ? {plain: true} : {units: figure.x.units, dimension: figure.x.dimension};
  const yAxis = panel => panel.unitsLabel ? {plain: panel.unitsLabel} : {units: panel.units, dimension: panel.dimension};
  /** Labels along an axis, thinned so none overlaps the previous one. */
  function placeLabels(ctx, items, horizontal, gap = 10) {
    const kept = []; let last = -Infinity;
    for (const it of items.sort((a, b) => a.pos - b.pos)) { const w = horizontal ? ctx.measureText(it.text).width : 12; const lo = it.pos - (horizontal ? w / 2 : w / 2); if (lo < last + gap) continue; kept.push(it); last = it.pos + (horizontal ? w / 2 : w / 2); }
    return kept;
  }
  function drawBase() {
    frame = 0; colors = palette(host); state.layout = layout();
    const L = state.layout, ctx = size(base, L.width, L.height); size(over, L.width, L.height);
    if (!state.xRange) state.xRange = fullX();
    state.yNow = figure.panels.map((_, p) => state.yRange[p] || autoY(p));
    ctx.clearRect(0, 0, L.width, L.height); ctx.fillStyle = colors.bg; ctx.fillRect(0, 0, L.width, L.height);
    ctx.font = '11px Inter, Segoe UI, system-ui, sans-serif'; ctx.textBaseline = 'middle';
    // x ticks, shared by every panel
    const [x0, x1] = state.xRange, xa = xAxis();
    let xticks;
    if (state.logX) xticks = logTicks(x0, x1, Math.max(2, L.plotW / 70)).map(t => ({...t, pos: px(t.at), text: valueText(t.value, xa, 3)}));
    else {
      const {ticks} = linearTicks(x0, x1, Math.max(2, Math.floor(L.plotW / 90)));
      const sys = xa.units !== undefined ? unitSystem(xa.units, xa.dimension) : null, big = Math.max(...ticks.map(Math.abs), 0);
      const [unit, scale] = sys && sys.kind === 'named' ? unitFor(sys, big) : sys && sys.kind === 'percent' ? ['%', 0.01] : ['', 1];
      xticks = ticks.map(t => ({at: t, major: true, label: true, pos: px(t), text: xa.harmonics || xa.plain ? significant(t, 4) : `${significant(t / scale, 4)}${unit ? ` ${unit}` : ''}`}));
    }
    figure.panels.forEach((panel, p) => {
      const r = L.panels[p], [lo, hi] = state.yNow[p], ya = yAxis(panel);
      // Value ticks are plain numbers; their unit goes in the panel title, so labels stay short.
      let yticks, yUnit;
      if (state.logY[p]) {
        const sys = ya.plain ? null : unitSystem(ya.units, ya.dimension), [unit, scale] = sys && sys.kind !== 'plain' ? unitFor(sys, 10 ** hi) : [ya.plain && ya.plain !== true ? ya.plain : sys?.label || '', 1];
        yUnit = unit; yticks = logTicks(lo, hi, Math.max(2, r.height / 28)).map(t => ({...t, pos: py(p, t.at), text: t.step ? tickText(t.value / scale, t.step / scale) : tickNum(t.value / scale, 3)}));
      } else {
        const {ticks, step} = linearTicks(lo, hi, Math.max(2, Math.floor(r.height / 34)), panel.phase);
        const sys = ya.plain ? null : unitSystem(ya.units, ya.dimension), big = Math.max(...ticks.map(Math.abs), 0);
        const [unit, scale] = sys && sys.kind !== 'plain' ? unitFor(sys, big) : [ya.plain && ya.plain !== true ? ya.plain : sys?.label || '', 1];
        yUnit = unit; yticks = ticks.map(t => ({at: t, major: t === 0, label: true, pos: py(p, t), text: tickText(t / scale, step / scale)}));
      }
      // title: the expression and its unit
      ctx.fillStyle = colors.text; ctx.textAlign = 'left'; ctx.font = '600 12px Inter, Segoe UI, system-ui, sans-serif';
      let title = `${panel.title}${yUnit ? `  (${yUnit}${state.logY[p] ? ', log' : ''})` : state.logY[p] ? '  (log)' : ''}`; const room = L.width - LEFT - RIGHT;
      while (title.length > 8 && ctx.measureText(title).width > room) title = `${title.slice(0, -2)}…`.replace(/……$/, '…');
      ctx.fillText(title, LEFT, r.top - TITLE / 2 + 1);
      ctx.font = '11px Inter, Segoe UI, system-ui, sans-serif';
      // grid
      ctx.save(); ctx.beginPath(); ctx.rect(LEFT, r.top, L.plotW, r.height); ctx.clip();
      ctx.lineWidth = 1;
      for (const t of xticks) { ctx.strokeStyle = t.major ? colors.major : colors.grid; ctx.beginPath(); ctx.moveTo(Math.round(t.pos) + .5, r.top); ctx.lineTo(Math.round(t.pos) + .5, r.top + r.height); ctx.stroke(); }
      for (const t of yticks) { ctx.strokeStyle = t.major ? colors.major : colors.grid; ctx.beginPath(); ctx.moveTo(LEFT, Math.round(t.pos) + .5); ctx.lineTo(LEFT + L.plotW, Math.round(t.pos) + .5); ctx.stroke(); }
      // integration floor
      if (panel.floor) { const fy = py(p, ty(p, panel.floor.value)); ctx.fillStyle = colors.floor; ctx.fillRect(LEFT, fy, L.plotW, r.top + r.height - fy); ctx.strokeStyle = colors.ref; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(LEFT, fy); ctx.lineTo(LEFT + L.plotW, fy); ctx.stroke(); ctx.setLineDash([]); }
      // reference lines (0 dB, -180 deg of a loop gain)
      for (const ref of panel.refs) { const y = py(p, ty(p, ref.value)); ctx.strokeStyle = colors.ref; ctx.setLineDash([2, 3]); ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(LEFT, y); ctx.lineTo(LEFT + L.plotW, y); ctx.stroke(); ctx.setLineDash([]); }
      // curves
      const shown = visible(panel);
      shown.forEach((s, i) => panel.stems ? drawStems(ctx, p, s, style(s.step), (i - (shown.length - 1) / 2) * Math.min(2, 14 / shown.length)) : drawSeries(ctx, p, s, style(s.step), 1.5));
      // limits
      ctx.lineWidth = 1.5; const labels = [];
      for (const m of panel.marks) {
        const c = m.fail ? colors.fail : colors.limit;
        if (m.kind === 'line') { const y = py(p, ty(p, m.value)); ctx.strokeStyle = c; ctx.setLineDash([6, 4]); ctx.beginPath(); ctx.moveTo(LEFT, y); ctx.lineTo(LEFT + L.plotW, y); ctx.stroke(); ctx.setLineDash([]); labels.push({y, text: m.label, color: c}); }
        else {
          const x = px(tx(m.at)); if (!Number.isFinite(x)) continue;
          const yTop = m.max !== null ? py(p, ty(p, m.max)) : r.top, yBot = m.min !== null ? py(p, ty(p, m.min)) : r.top + r.height;
          ctx.strokeStyle = c; ctx.beginPath(); ctx.moveTo(x - 5, yTop); ctx.lineTo(x + 5, yTop); ctx.moveTo(x - 5, yBot); ctx.lineTo(x + 5, yBot); ctx.moveTo(x, yTop); ctx.lineTo(x, yBot); ctx.stroke();
          for (const pt of m.points) { if (state.hidden.has(pt.step) || pt.value === null) continue; const y = py(p, ty(p, pt.value)); if (!Number.isFinite(y)) continue; ctx.fillStyle = pt.pass === false ? colors.fail : style(pt.step).color; ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill(); }
          labels.push({y: Math.max(r.top + 8, Math.min(r.top + r.height - 8, (yTop + yBot) / 2)), x: x + 8, text: m.label, color: c, window: true});
        }
      }
      ctx.restore();
      // limit labels, right-aligned (windows beside their window), nudged apart, and off-scale ones at the edge
      let lastY = -Infinity;
      for (const l of labels.filter(x => x.text).sort((a, b) => a.y - b.y)) {
        let y = l.y, edge = '';
        if (y < r.top + 6) { y = r.top + 6; edge = '▲ '; } else if (y > r.top + r.height - 6) { y = r.top + r.height - 6; edge = '▼ '; }
        y = Math.max(y, lastY + 13, r.top + 16); if (y > r.top + r.height - 4) continue; lastY = y;
        let text = `${edge}${l.text}`; ctx.font = '11px Inter, Segoe UI, system-ui, sans-serif';
        while (text.length > 12 && ctx.measureText(text).width > L.plotW * 0.55) text = `${text.slice(0, -2).replace(/…$/, '')}…`;
        const w = ctx.measureText(text).width; let x = l.window ? Math.min(l.x, LEFT + L.plotW - w - 4) : LEFT + L.plotW - w - 4;
        x = Math.max(LEFT + 4, x);
        ctx.lineWidth = 3; ctx.strokeStyle = colors.bg; ctx.lineJoin = 'round'; ctx.textAlign = 'left'; ctx.strokeText(text, x, y - 7); ctx.fillStyle = l.color; ctx.fillText(text, x, y - 7);
      }
      if (panel.floor) { const fy = py(p, ty(p, panel.floor.value)); if (fy > r.top + 14 && fy < r.top + r.height - 4) { const text = panel.floor.label, w = ctx.measureText(text).width; ctx.textAlign = 'left'; ctx.lineWidth = 3; ctx.strokeStyle = colors.bg; ctx.strokeText(text, LEFT + 6, fy - 8); ctx.fillStyle = colors.muted; ctx.fillText(text, LEFT + 6, fy - 8); } }
      // frame and y labels
      ctx.strokeStyle = colors.frame; ctx.lineWidth = 1; ctx.strokeRect(LEFT + .5, r.top + .5, L.plotW - 1, r.height - 1);
      ctx.fillStyle = colors.muted; ctx.textAlign = 'right';
      for (const t of placeLabels(ctx, yticks.filter(t => t.label !== false && t.pos >= r.top - 1 && t.pos <= r.top + r.height + 1).map(t => ({...t})), false, 4)) ctx.fillText(t.text, LEFT - 6, t.pos);
      // x labels under the last panel only; the others share them
      if (p === figure.panels.length - 1) { ctx.textAlign = 'center'; ctx.fillStyle = colors.muted; for (const t of placeLabels(ctx, xticks.filter(t => t.label !== false && t.pos >= LEFT - 1 && t.pos <= LEFT + L.plotW + 1), true)) ctx.fillText(t.text, Math.min(Math.max(t.pos, LEFT + ctx.measureText(t.text).width / 2), LEFT + L.plotW - ctx.measureText(t.text).width / 2), r.top + r.height + 12); }
    });
    const last = L.panels[L.panels.length - 1];
    ctx.fillStyle = colors.muted; ctx.textAlign = 'center';
    ctx.fillText(`${figure.x.label || figure.x.name}${state.logX ? ' (log scale)' : ''}`, LEFT + L.plotW / 2, last.top + last.height + 30);
    drawOverlay();
  }
  /** A spectrum's bins as stems from the bottom of the panel with a dot on top; steps side by side by `dx` pixels. */
  function drawStems(ctx, p, s, st, dx, width = 1.2) {
    const [x0, x1] = state.xRange, r = state.layout.panels[p], bottom = r.top + r.height;
    ctx.strokeStyle = st.color; ctx.fillStyle = st.color; ctx.lineWidth = width; ctx.setLineDash([]);
    for (let i = 0; i < s.x.length; i++) {
      const t = tx(s.x[i]); if (!(t >= x0 && t <= x1)) continue; const v = ty(p, s.y[i]); if (!Number.isFinite(v)) continue;
      const X = px(t) + dx, Y = Math.max(r.top, py(p, v)); if (Y >= bottom) continue;
      ctx.beginPath(); ctx.moveTo(X, bottom); ctx.lineTo(X, Y); ctx.stroke(); ctx.beginPath(); ctx.arc(X, Y, width > 1.5 ? 3 : 2, 0, Math.PI * 2); ctx.fill();
    }
  }
  function drawSeries(ctx, p, s, st, width) {
    const [x0, x1] = state.xRange, xs = s.x, ys = s.y, n = xs.length;
    let i0 = Math.max(0, lower(xs, untx(x0)) - 1), i1 = Math.min(n, lower(xs, untx(x1)) + 2);
    if (state.logX) while (i0 < i1 && !(xs[i0] > 0)) i0++;
    ctx.strokeStyle = st.color; ctx.lineWidth = width; ctx.setLineDash(st.dash); ctx.lineJoin = 'round'; ctx.beginPath();
    let pen = false;
    const point = (X, Y) => { if (pen) ctx.lineTo(X, Y); else { ctx.moveTo(X, Y); pen = true; } };
    if (i1 - i0 > state.layout.plotW * 2) {
      // Long records: the first, lowest, highest and last value of each pixel column, so no peak is lost.
      let col = null, first, last, mn, mx, mnAt, mxAt;
      const flush = () => { if (col === null) return; const pts = [[0, first], [mnAt < mxAt ? 1 : 2, mnAt < mxAt ? mn : mx], [mnAt < mxAt ? 2 : 1, mnAt < mxAt ? mx : mn], [3, last]]; for (const [, v] of pts) point(col, v); };
      for (let i = i0; i < i1; i++) {
        const X = px(tx(xs[i])), v = ty(p, ys[i]);
        if (!Number.isFinite(v) || !Number.isFinite(X)) { flush(); col = null; pen = false; continue; }
        const Y = py(p, v), c = Math.round(X);
        if (c !== col) { flush(); col = c; first = last = mn = mx = Y; mnAt = mxAt = i; }
        else { last = Y; if (Y < mn) { mn = Y; mnAt = i; } if (Y > mx) { mx = Y; mxAt = i; } }
      }
      flush();
    } else for (let i = i0; i < i1; i++) { const X = px(tx(xs[i])), v = ty(p, ys[i]); if (!Number.isFinite(v) || !Number.isFinite(X)) { pen = false; continue; } point(X, py(p, v)); }
    ctx.stroke(); ctx.setLineDash([]);
  }
  /** The value of a series at x (data units), linear between samples; null outside its record or in a gap. */
  function valueAt(s, x, stems = false) {
    const xs = s.x, i = lower(xs, x);
    if (stems || s.stems) { if (!xs.length) return null; const k = i <= 0 ? 0 : i >= xs.length ? xs.length - 1 : (Math.abs(tx(xs[i]) - tx(x)) < Math.abs(tx(xs[i - 1]) - tx(x)) ? i : i - 1); return Number.isFinite(s.y[k]) ? s.y[k] : null; } if (i <= 0) return xs[0] === x ? s.y[0] : null; if (i >= xs.length) return null;
    const a = xs[i - 1], b = xs[i], va = s.y[i - 1], vb = s.y[i]; if (!Number.isFinite(va) || !Number.isFinite(vb)) return Number.isFinite(va) && x - a < b - x ? va : Number.isFinite(vb) ? vb : null;
    if (state.logX && a > 0 && b > 0) { const f = (Math.log10(x) - Math.log10(a)) / (Math.log10(b) - Math.log10(a)); return va + (vb - va) * f; }
    return va + (vb - va) * (x - a) / (b - a || 1);
  }
  function panelAt(Y) { return state.layout.panels.findIndex(r => Y >= r.top - 4 && Y <= r.top + r.height + 4); }
  function nearest(p, X, Y) {
    const x = untx(pxInv(X)); let best = null;
    for (const s of visible(figure.panels[p])) { const v = valueAt(s, x); if (v === null) continue; const yy = py(p, ty(p, v)); if (!Number.isFinite(yy)) continue; const d = Math.abs(yy - Y); if (!best || d < best.d) best = {d, step: s.step, value: v, series: s}; }
    if (best?.series.stems) { const xs = best.series.x, i = Math.min(xs.length - 1, Math.max(0, lower(xs, x))); const k = i > 0 && Math.abs(tx(xs[i - 1]) - tx(x)) < Math.abs(tx(xs[i]) - tx(x)) ? i - 1 : i; return {x: xs[k], panel: p, step: best.step, value: best.series.y[k], series: best.series}; }
    return best && {x, panel: p, step: best.step, value: best.value, series: best.series};
  }
  function drawOverlay() {
    overFrame = 0; const L = state.layout; if (!L) return;
    const ctx = over.getContext('2d'), dpr = devicePixelRatio || 1; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, L.width, L.height);
    const top = L.panels[0].top, bottom = L.panels[L.panels.length - 1].top + L.panels[L.panels.length - 1].height;
    const line = (x, color, dash, label) => { const X = px(tx(x)); if (!(X >= LEFT && X <= LEFT + L.plotW)) return; ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash(dash); ctx.beginPath(); ctx.moveTo(X + .5, top); ctx.lineTo(X + .5, bottom); ctx.stroke(); ctx.setLineDash([]); if (label) { ctx.font = '700 11px Inter, Segoe UI, system-ui, sans-serif'; ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.fillText(label, X, top - 6); } };
    const dot = (p, x, v, step, color) => { const X = px(tx(x)), Y = py(p, ty(p, v)); if (!Number.isFinite(Y) || Y < L.panels[p].top || Y > L.panels[p].top + L.panels[p].height) return; ctx.fillStyle = colors.bg; ctx.strokeStyle = color || style(step).color; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(X, Y, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); };
    if (state.hover) {
      const h = state.hover; line(h.x, colors.muted, [3, 3]);
      ctx.save(); figure.panels.forEach((panel, p) => { const r = L.panels[p]; ctx.save(); ctx.beginPath(); ctx.rect(LEFT, r.top, L.plotW, r.height); ctx.clip(); const s = visible(panel).find(x => x.step === h.step); if (s) { if (panel.stems) drawStems(ctx, p, s, style(s.step), 0, 2.4); else drawSeries(ctx, p, s, style(s.step), 2.6); } ctx.restore(); const v = s && valueAt(s, h.x); if (v !== null && v !== undefined) dot(p, h.x, v, h.step); }); ctx.restore();
    }
    for (const [i, c] of state.cursors.entries()) { line(c.x, colors.cursor, [], i ? 'B' : 'A'); const s = figure.panels[c.panel].series.find(x => x.step === c.step); const v = s?.y && valueAt(s, c.x); if (v !== null && v !== undefined) dot(c.panel, c.x, v, c.step, colors.cursor); }
    if (state.drag?.kind === 'box') { const d = state.drag; ctx.fillStyle = colors.box; ctx.strokeStyle = colors.cursor; ctx.lineWidth = 1; const r = L.panels[d.panel]; const yb = d.tall ? [Math.min(d.y0, d.y1), Math.abs(d.y1 - d.y0)] : [r.top, r.height]; ctx.fillRect(Math.min(d.x0, d.x1), yb[0], Math.abs(d.x1 - d.x0), yb[1]); ctx.strokeRect(Math.min(d.x0, d.x1) + .5, yb[0] + .5, Math.abs(d.x1 - d.x0), yb[1]); }
    renderReadout();
  }
  const xText = x => figure.x.periods ? `${significant(x, 4)} periods` : valueText(x, xAxis(), 5);
  const yText = (p, v) => { const panel = figure.panels[p]; return panel.unitsLabel ? `${significant(v, 4)} ${panel.unitsLabel}` : formatQuantity(v, panel.units, panel.dimension, {digits: 4}); };
  function swatch(step) { const i = document.createElement('i'); i.className = 'sim-swatch'; i.style.background = style(step).color; return i; }
  function item(parent, text, step, cls) { const s = document.createElement('span'); s.className = cls || 'sim-readout-item'; if (step !== undefined && step !== null) s.append(swatch(step)); s.append(text); parent.append(s); return s; }
  function renderReadout() {
    readout.replaceChildren();
    const h = state.hover;
    if (!h && !state.cursors.length) { item(readout, figure.hint || 'Hover to read values · click to place cursors A and B · drag a box to zoom · Ctrl+wheel zooms · double-click resets', null, 'sim-readout-hint'); return; }
    const row = cls => { const d = document.createElement('div'); d.className = cls || 'sim-readout-row'; readout.append(d); return d; };
    if (h) {
      const r = row(); item(r, `${figure.x.label || figure.x.name} ${xText(h.x)}`, null, 'sim-readout-x');
      const s0 = h.series; if (s0?.time) item(r, `t ${formatQuantity(valueAt({x: s0.x, y: s0.time}, h.x), 's', 'Time', {digits: 4})}`, null, 'sim-readout-x');
      item(r, style(h.step).label, h.step, 'sim-readout-step');
      for (const [p, panel] of figure.panels.entries()) { const s = panel.series.find(x => x.step === h.step); const v = s?.y ? valueAt(s, h.x) : null; item(r, `${panel.title}: ${v === null ? '-' : yText(p, v)}`); }
      const shown = visible(figure.panels[h.panel]);
      if (shown.length > 1 && shown.length <= 8) { const r2 = row('sim-readout-row sim-readout-steps'); for (const s of shown) { if (s.step === h.step) continue; const v = valueAt(s, h.x); item(r2, `${style(s.step).label}: ${v === null ? '-' : yText(h.panel, v)}`, s.step); } }
    }
    if (state.cursors.length) {
      const r = row('sim-readout-row sim-readout-cursors');
      const val = c => { const s = figure.panels[c.panel].series.find(x => x.step === c.step); return s?.y ? valueAt(s, c.x) : null; };
      for (const [i, c] of state.cursors.entries()) { const v = val(c); item(r, `${i ? 'B' : 'A'}: ${xText(c.x)}, ${figure.panels[c.panel].title} ${v === null ? '-' : yText(c.panel, v)}`, c.step); }
      if (state.cursors.length === 2) {
        const [a, b] = state.cursors, dx = b.x - a.x, va = val(a), vb = val(b);
        const parts = [`Δx ${figure.x.periods ? `${significant(dx, 4)} periods` : figure.x.harmonics ? significant(dx, 4) : formatQuantity(dx, figure.x.units, figure.x.dimension, {digits: 4})}`];
        if (figure.x.units === 's' && dx) parts.push(`1/Δx ${formatQuantity(1 / Math.abs(dx), 'Hz', 'Frequency', {digits: 4})}`);
        if (figure.x.units === 'Hz' && a.x > 0 && b.x > 0) parts.push(`${significant(Math.log10(b.x / a.x), 3)} decades`);
        if (a.panel === b.panel && va !== null && vb !== null) { parts.push(`Δy ${yText(a.panel, vb - va)}`); if (dx && figure.x.units === 'Hz' && /dB/.test(figure.panels[a.panel].units + (figure.panels[a.panel].unitsLabel || ''))) parts.push(`${significant((vb - va) / Math.log10(b.x / a.x), 3)} dB/decade`); }
        item(r, parts.join(' · '), null, 'sim-readout-delta');
      }
      const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'sim-mini'; clear.textContent = 'Clear cursors'; clear.onclick = () => { state.cursors = []; drawOverlay(); }; r.append(clear);
    }
  }
  const redraw = () => { if (!frame) frame = requestAnimationFrame(drawBase); };
  const redrawOverlay = () => { if (!overFrame) overFrame = requestAnimationFrame(drawOverlay); };
  const local = e => { const r = over.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const inPlot = (X, Y) => X >= LEFT && X <= LEFT + state.layout.plotW && panelAt(Y) >= 0;
  function zoomX(center, factor) { const [a, b] = state.xRange; state.xRange = [center - (center - a) * factor, center + (b - center) * factor]; }
  over.addEventListener('pointermove', e => {
    if (!state.layout) return; const [X, Y] = local(e);
    if (state.drag) {
      const d = state.drag;
      if (d.kind === 'box') { d.x1 = Math.max(LEFT, Math.min(LEFT + state.layout.plotW, X)); d.y1 = Y; d.tall = Math.abs(d.y1 - d.y0) > 12; redrawOverlay(); }
      else { const dx = (X - d.X) / state.layout.plotW * (d.range[1] - d.range[0]); state.xRange = [d.range[0] - dx, d.range[1] - dx]; if (d.y && d.panel >= 0) { const r = state.layout.panels[d.panel], dy = (Y - d.Y) / r.height * (d.y[1] - d.y[0]); state.yRange[d.panel] = [d.y[0] + dy, d.y[1] + dy]; } redraw(); }
      return;
    }
    const p = panelAt(Y);
    state.hover = p >= 0 && inPlot(X, Y) ? nearest(p, X, Y) : null; redrawOverlay();
  });
  over.addEventListener('pointerleave', () => { if (!state.drag) { state.hover = null; redrawOverlay(); } });
  over.addEventListener('contextmenu', e => e.preventDefault());
  over.addEventListener('pointerdown', e => {
    if (!state.layout) return; const [X, Y] = local(e), p = panelAt(Y); if (p < 0 || !inPlot(X, Y)) return;
    try { over.setPointerCapture(e.pointerId); } catch {} wrap.focus({preventScroll: true});
    if (e.button === 1 || e.button === 2 || e.shiftKey) state.drag = {kind: 'pan', X, Y, range: [...state.xRange], panel: p, y: [...state.yNow[p]]};
    else if (e.button === 0) state.drag = {kind: 'box', x0: X, y0: Y, x1: X, y1: Y, panel: p, tall: false};
    e.preventDefault();
  });
  over.addEventListener('pointerup', e => {
    const d = state.drag; state.drag = null; if (!d || !state.layout) return;
    if (d.kind === 'box') {
      if (Math.abs(d.x1 - d.x0) > 5) {
        const a = pxInv(Math.min(d.x0, d.x1)), b = pxInv(Math.max(d.x0, d.x1)); state.xRange = [a, b];
        if (d.tall) { const lo = pyInv(d.panel, Math.max(d.y0, d.y1)), hi = pyInv(d.panel, Math.min(d.y0, d.y1)); state.yRange[d.panel] = [lo, hi]; }
        redraw();
      } else {
        const [X, Y] = local(e), p = panelAt(Y), hit = p >= 0 ? nearest(p, X, Y) : null;
        if (hit) { state.cursors = state.cursors.length >= 2 ? [hit] : [...state.cursors, hit]; } redrawOverlay();
      }
    }
  });
  over.addEventListener('dblclick', () => { reset(); });
  over.addEventListener('wheel', e => {
    if (!(e.ctrlKey || e.metaKey) || !state.layout) return; const [X, Y] = local(e), p = panelAt(Y); if (!inPlot(X, Y)) return;
    e.preventDefault(); const f = e.deltaY > 0 ? 1.25 : 0.8;
    if (e.shiftKey && p >= 0) { const c = pyInv(p, Y), [a, b] = state.yNow[p]; state.yRange[p] = [c - (c - a) * f, c + (b - c) * f]; } else zoomX(pxInv(X), f);
    redraw();
  }, {passive: false});
  wrap.addEventListener('keydown', e => {
    if (!state.xRange) return; const [a, b] = state.xRange, w = b - a; let done = true;
    if (e.key === 'ArrowLeft') state.xRange = [a - w * .1, b - w * .1]; else if (e.key === 'ArrowRight') state.xRange = [a + w * .1, b + w * .1];
    else if (e.key === '+' || e.key === '=') zoomX((a + b) / 2, .8); else if (e.key === '-') zoomX((a + b) / 2, 1.25);
    else if (e.key === '0' || e.key === 'Home') reset(); else if (e.key === 'Escape' && state.cursors.length) { state.cursors = []; drawOverlay(); return e.stopPropagation(); }
    else done = false;
    if (done) { e.preventDefault(); redraw(); }
  });
  function reset() { state.xRange = null; state.yRange = figure.panels.map(() => null); redraw(); }
  const resize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { const w = wrap.clientWidth; if (w && w !== state.width) { state.width = w; redraw(); } }) : null;
  resize?.observe(wrap);
  const handle = {
    redraw, reset,
    setHidden(set) { state.hidden = set; redraw(); },
      setLogX(on) { if (on === state.logX) return; state.logX = on; state.xRange = null; state.cursors = []; redraw(); },
      setLogY(on) { state.logY = figure.panels.map((p, i) => on && p.canLogY !== false ? true : on ? state.logY[i] : false); state.yRange = figure.panels.map(() => null); redraw(); },
      get logX() { return state.logX; }, get logY() { return state.logY.some(Boolean); },
      destroy() { resize?.disconnect(); charts.delete(handle); },
      host,
  };
  charts.add(handle); watchTheme();
  drawBase();
  return handle;
}
/** Forget charts whose canvases left the page (the panel re-renders a bench). */
export function pruneCharts() { for (const c of charts) if (!c.host.isConnected) c.destroy(); }
