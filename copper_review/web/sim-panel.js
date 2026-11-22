/* The simulation view: a finished `copper sim` run read from sim-results.json. Benches on the left with
 * their verdicts; on the right the run overview (failing limits first) or one bench: its plots drawn
 * interactively, then its measures with value, limit and margin per step, then noise, poles, Monte
 * Carlo, rails, stress and notes. DOM only; the data and wording come from sim.js. */
import {benchGroups, failures, verdictText, verdictLine, analysisText, measureCells, stepStyles, stepShort, plotFigures, spectrumFigure, spectrumStepText,
  noiseAt, noiseByOwner, histogram, variationRows, railsAt, fidelityLine, modelGroups, formatQuantity, significant, mergeCsv, STEP_COLORS} from './sim.js';
import {createChart, pruneCharts} from './sim-chart.js';
import {histogramSvg, poleMapSvg, noiseSharesSvg} from './sim-svg.js';
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = text; return e; };
const button = (text, cls, onclick) => { const b = el('button', cls, text); b.type = 'button'; if (onclick) b.onclick = onclick; return b; };
const plural = (k, word, many = `${word}s`) => `${k} ${k === 1 ? word : many}`;
const basename = p => String(p || '').split(/[\\/]/).pop();
const V = (v, units, dimension) => formatQuantity(v, units, dimension);
function table(head, rows, cls) {
  const t = el('table', `sim-table${cls ? ` ${cls}` : ''}`);
  if (head) { const tr = el('tr'); for (const h of head) tr.append(typeof h === 'string' ? el('th', null, h) : h); const th = el('thead'); th.append(tr); t.append(th); }
  const body = el('tbody'); for (const r of rows) { const tr = el('tr'); for (const c of r) tr.append(c instanceof Node ? c : el('td', null, c)); body.append(tr); } t.append(body);
  const wrap = el('div', 'sim-scroll'); wrap.append(t); return wrap;
}
const td = (text, cls, title) => { const c = el('td', cls, text); if (title) c.title = title; return c; };
function folded(summary, content, open = false) { const d = el('details', 'sim-folded'); d.open = open; d.append(el('summary', null, summary)); d.append(...[content].flat()); return d; }
const chip = (verdict, text) => el('span', `sim-chip ${verdict}`, text || verdict);
/** The CSS colour of a step's style, for legends (the canvas resolves the same tokens itself). */
function swatchColor(style, k) {
  const c = style.color[k];
  if (c.ramp === undefined) return `var(--sim-step-${c.palette % STEP_COLORS})`;
  const p = c.ramp * 4, i = Math.min(3, Math.floor(p)), f = Math.round((p - i) * 100);
  return `color-mix(in srgb, var(--sim-ramp-${i}) ${100 - f}%, var(--sim-ramp-${i + 1}) ${f}%)`;
}
function lineSample(color, dash) {
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg'), line = document.createElementNS(ns, 'line');
  svg.setAttribute('viewBox', '0 0 24 8'); svg.setAttribute('class', 'sim-line-sample'); svg.setAttribute('aria-hidden', 'true');
  for (const [k, v] of Object.entries({x1: 1, y1: 4, x2: 23, y2: 4, 'stroke-width': 2.2, 'stroke-dasharray': dash.length ? dash.map(d => d * 0.6).join(' ') : 'none'})) line.setAttribute(k, v);
  line.style.stroke = color; svg.append(line); return svg;
}

export function createSimView(els, {message = () => {}, onChange = () => {}} = {}) {
  let model = null, selected = null, filter = 'all', query = '', charts = [];
  const benchState = new Map();
  const stateOf = b => { if (!benchState.has(b.index)) benchState.set(b.index, {hidden: new Set(), step: defaultStep(b), hiddenPlots: new Set(), logX: new Map(), logY: new Map(), measureQuery: ''}); return benchState.get(b.index); };
  function defaultStep(b) { const f = b.measures.find(m => m.status === 'fail' && m.worst_step !== null); return f ? f.worst_step : 0; }
  // ---- The bench list ---------------------------------------------------------------------------
  function matches(b) {
    if (filter === 'failing' && !['fail', 'error'].includes(b.verdict)) return false;
    if (filter === 'nolimit' && b.verdict !== 'no-limit') return false;
    if (!query) return true;
    const q = query.toLowerCase();
    return b.name.toLowerCase().includes(q) || b.measures.some(m => m.name.toLowerCase().includes(q)) || b.plots.some(p => p.expression.toLowerCase().includes(q));
  }
  function itemNote(b) {
    if (b.verdict === 'error') return 'not solved';
    const failing = b.measures.filter(m => m.status === 'fail').map(m => m.name);
    if (failing.length) return `fails: ${failing.slice(0, 2).join(', ')}${failing.length > 2 ? ` +${failing.length - 2}` : ''}`;
    return `${b.analysis.kind}${b.steps.length > 1 ? ` · ${b.steps.length} steps` : ''} · ${b.counts.limited ? `${b.counts.limited}/${b.counts.limited} pass` : 'no limits'}`;
  }
  function renderList() {
    els.list.replaceChildren();
    const counts = {all: model.benches.length, failing: model.benches.filter(b => ['fail', 'error'].includes(b.verdict)).length, nolimit: model.benches.filter(b => b.verdict === 'no-limit').length};
    for (const b of els.filters.querySelectorAll('[data-filter]')) { const k = b.dataset.filter; b.classList.toggle('active', k === filter); b.setAttribute('aria-pressed', String(k === filter)); b.querySelector('span').textContent = counts[k]; }
    const over = button('Overview', 'sim-item sim-overview-item'); over.setAttribute('aria-pressed', String(selected === null)); over.onclick = () => select(null); els.list.append(over);
    let shown = 0;
    for (const g of benchGroups(model)) {
      const benches = g.benches.filter(matches); if (!benches.length) continue;
      const sectioned = g.benches.length > 1 || g.benches[0].section !== null;
      if (sectioned) els.list.append(el('div', 'sim-group', g.name));
      for (const b of benches) {
        const item = button(null, `sim-item${sectioned ? ' sim-section-item' : ''}`); item.dataset.bench = b.name; item.setAttribute('aria-pressed', String(selected === b.index));
        const dot = el('span', `sim-dot ${b.verdict}`); dot.title = verdictText(b);
        const text = el('span', 'sim-item-text'); text.append(el('span', 'sim-item-title', sectioned && b.section ? b.section : b.name), el('span', 'sim-item-note', itemNote(b)));
        item.append(dot, text); item.onclick = () => select(b.index); els.list.append(item); shown++;
      }
    }
    if (!shown) els.list.append(el('p', 'quiet', filter === 'failing' ? 'No bench fails.' : filter === 'nolimit' ? 'Every bench judges at least one limit.' : 'No bench matches.'));
  }
  // ---- Overview: failing limits first, then every bench -----------------------------------------
  function renderOverview() {
    const d = els.detail, s = model.source, all = model.benches.flatMap(b => b.measures);
    const head = el('div', 'sim-head'); head.append(el('h2', null, model.board || 'Simulation results'), chip(model.status === 'pass' ? 'pass' : model.status, model.status === 'pass' ? 'run passes' : model.status === 'fail' ? 'run fails' : 'run has errors'));
    d.append(head);
    const limited = all.filter(m => m.status !== 'no_limit').length;
    d.append(el('p', 'sim-sub', `${plural(model.benches.length, 'bench', 'benches')} · ${plural(all.length, 'measure')}, ${limited} with limits · ${model.file || 'sim-results.json'}${model.sha256 ? ` · ${model.sha256.slice(0, 12)}` : ''}`));
    // A strip of one tile per bench: the whole run at a glance.
    const strip = el('div', 'sim-strip'); strip.setAttribute('aria-label', 'Benches by verdict');
    for (const b of model.benches) { const t = button(null, `sim-tile ${b.verdict}`); t.title = `${b.name}: ${verdictText(b)} · ${verdictLine(b)}`; t.setAttribute('aria-label', t.title); t.onclick = () => select(b.index); strip.append(t); }
    const legend = el('p', 'sim-strip-legend'); for (const [v, text] of [['pass', 'pass'], ['fail', 'fail'], ['error', 'error'], ['no-limit', 'no limits (nothing judged)']]) { const n = model.benches.filter(b => b.verdict === v).length; if (!n) continue; const s2 = el('span'); s2.append(el('i', `sim-dot ${v}`), `${n} ${text}`); legend.append(s2); }
    d.append(strip, legend);
    for (const note of model.notes) d.append(el('p', 'sim-note warning', note));
    const fails = failures(model);
    d.append(el('h3', null, fails.length ? `Failing limits (${fails.length})` : 'Failing limits'));
    if (!fails.length) d.append(el('p', 'sim-ok', `None: ${limited} of ${plural(limited, 'limited measure')} pass in every step they cover.${all.length - limited ? ` ${all.length - limited} measures have no limits and are not judged.` : ''}`));
    else d.append(table(['bench', 'measure', 'worst step', 'value', 'limit', 'margin', 'steps'], fails.map(f => {
      const name = td(f.bench.name, 'sim-link'); name.onclick = () => select(f.bench.index);
      if (f.error) return [name, td('not solved', 'fail'), td(f.error, null), '', '', '', ''];
      return [name, td(f.measure.name, null, f.measure.expression), td(f.stepLabel || '-'), td(f.worst?.value || '-', 'num fail'), td(f.worst?.limit || f.measure.limits), td(f.worst?.marginText || '', 'num fail'), td(`fails at ${f.failingSteps} of ${f.steps}`)];
    }), 'sim-fails'));
    d.append(el('h3', null, 'Benches'));
    d.append(table(['bench', 'analysis', 'steps', 'verdict', 'measures'], model.benches.map(b => {
      const name = td(b.name, 'sim-link'); name.onclick = () => select(b.index);
      const v = el('td'); v.append(chip(b.verdict, verdictText(b)));
      return [name, td(analysisText(b)), td(String(b.steps.length), 'num'), v, td(verdictLine(b))];
    }), 'sim-bench-table'));
    const info = [];
    if (model.solver) info.push(`Solver: ${model.solver.name} ${model.solver.version}, ${model.solver.method}.`);
    if (s) info.push(`Board file ${s.board_file} · design ${s.design_sha256.slice(0, 12)} · benches ${s.benches_sha256.slice(0, 12)}.`);
    info.push('Nothing here checks these results against an open board or schematic; copper check --sim-results does that from the board itself.');
    d.append(folded('About this run', info.map(t => el('p', 'quiet', t))));
  }
  // ---- One bench ---------------------------------------------------------------------------------
  function stepLegend(b, st, style, refresh) {
    const box = el('div', 'sim-legend');
    if (b.steps.length < 2) return box;
    const toggle = steps => { const allShown = steps.every(k => !st.hidden.has(k)); for (const k of steps) allShown ? st.hidden.add(k) : st.hidden.delete(k); refresh(); };
    const chipFor = (text, steps, color, dash, title) => { const c = button(null, 'sim-step-chip'); c.title = title || text; c.setAttribute('aria-pressed', String(steps.some(k => !st.hidden.has(k)))); if (color) c.append(lineSample(color, dash || [])); c.append(el('span', null, text)); c.onclick = () => toggle(steps); return c; };
    if (b.steps.length <= STEP_COLORS || !style.factors.length) {
      const row = el('div', 'sim-legend-row'); row.append(el('span', 'sim-legend-name', 'Steps'));
      b.steps.forEach((s, k) => row.append(chipFor(stepShort(b, k), [k], swatchColor(style, k), DASH(style, k), s.label)));
      box.append(row);
    } else {
      style.factors.forEach((f, i) => {
        if (f.levels.length < 2) return;
        const row = el('div', 'sim-legend-row'); row.append(el('span', 'sim-legend-name', `${f.names.join(', ')}${i === style.colorFactor ? ' (colour)' : i === style.dashFactor ? ' (dash)' : ''}`));
        f.levels.forEach((level, l) => { const steps = b.steps.map((_, k) => k).filter(k => f.of_step[k] === l), k0 = steps[0]; row.append(chipFor(level, steps, i === style.colorFactor ? swatchColor(style, k0) : i === style.dashFactor ? 'var(--muted)' : null, i === style.dashFactor ? DASH(style, k0) : [], `${f.names.join(', ')} = ${level}: ${plural(steps.length, 'step')}`)); });
        box.append(row);
      });
      const list = el('div', 'sim-step-list');
      b.steps.forEach((s, k) => { const l = el('label'); const c = el('input'); c.type = 'checkbox'; c.checked = !st.hidden.has(k); c.onchange = () => { c.checked ? st.hidden.delete(k) : st.hidden.add(k); refresh(); }; l.append(c, lineSample(swatchColor(style, k), DASH(style, k)), s.label); list.append(l); });
      box.append(folded(`Every step (${b.steps.length})`, list));
    }
    const row = el('div', 'sim-legend-row sim-legend-actions');
    row.append(button('Show all steps', 'sim-mini', () => { st.hidden.clear(); refresh(); }));
    const worst = b.measures.find(m => m.worst_step !== null && m.status === 'fail') || b.measures.find(m => m.worst_step !== null);
    if (worst) row.append(button(`Only the worst step of ${worst.name}`, 'sim-mini', () => { st.hidden = new Set(b.steps.map((_, k) => k).filter(k => k !== worst.worst_step)); refresh(); }));
    row.append(el('span', 'quiet', `${b.steps.length - st.hidden.size} of ${b.steps.length} steps shown`));
    box.append(row);
    return box;
  }
  const DASH = (style, k) => [[], [8, 4], [2, 3], [10, 3, 2, 3]][style.dash[k] % 4];
  function chartBlock(host, figure, st, style, b, key) {
    const tools = el('div', 'sim-chart-tools');
    const fig = el('div', 'sim-chart');
    let chart;
    const toggle = (label, on, set, title) => { const t = button(label, 'sim-mini'); t.setAttribute('aria-pressed', String(on)); t.title = title; t.onclick = () => { const next = t.getAttribute('aria-pressed') !== 'true'; t.setAttribute('aria-pressed', String(next)); set(next); }; return t; };
    if (figure.x.canLog && figure.x.scale !== 'log') tools.append(toggle('Log x', st.logX.get(key) ?? figure.x.logDefault, on => { st.logX.set(key, on); chart.setLogX(on); }, 'Logarithmic x axis'));
    else if (figure.x.scale === 'log') tools.append(toggle('Log x', st.logX.get(key) ?? true, on => { st.logX.set(key, on); chart.setLogX(on); }, 'Logarithmic x axis (the data is a log sweep)'));
    if (figure.panels.some(p => p.canLogY)) tools.append(toggle('Log y', st.logY.get(key) ?? figure.panels.some(p => p.logY), on => { st.logY.set(key, on); chart.setLogY(on); }, 'Logarithmic value axis for panels whose values are all positive'));
    tools.append(button('Reset zoom', 'sim-mini', () => chart.reset()));
    host.append(tools, fig);
    const opts = {hidden: st.hidden, style: k => ({color: style.color[k], dash: DASH(style, k), label: b.steps.length > 1 ? stepShort(b, k) : b.steps[k]?.label || 'nominal'})};
    const f = {...figure, x: {...figure.x, logDefault: st.logX.get(key) ?? figure.x.logDefault}, panels: figure.panels.map(p => ({...p, logY: st.logY.has(key) ? st.logY.get(key) && p.canLogY : p.logY}))};
    chart = createChart(fig, f, opts); charts.push(chart);
    return chart;
  }
  function renderPlots(b, st, style, refreshCharts) {
    const figs = plotFigures(b);
    const box = el('section', 'sim-section');
    if (!figs.length) return null;
    const missingPanels = [];
    for (const fig of figs) {
      const panels = fig.panels.map(p => ({...p, title: p.expression})).filter(p => { if (p.missing.length === p.series.length) { missingPanels.push(p.expression); return false; } return true; });
      const shownPanels = panels.filter(p => !st.hiddenPlots.has(p.plot));
      if (fig.title) box.append(el('h4', 'sim-fig-title', fig.title));
      if (fig.layout === 'periods') box.append(el('p', 'quiet', 'The steps run for different times; each is drawn over its own periodic steady state, so the x axis counts periods of that step. The cursor readout also gives the time.'));
      if (panels.length > 1) {
        const row = el('div', 'sim-legend-row sim-plot-toggles'); row.append(el('span', 'sim-legend-name', 'Plots'));
        for (const p of panels) { const c = button(p.expression, 'sim-step-chip'); c.setAttribute('aria-pressed', String(!st.hiddenPlots.has(p.plot))); c.onclick = () => { st.hiddenPlots.has(p.plot) ? st.hiddenPlots.delete(p.plot) : st.hiddenPlots.add(p.plot); refreshCharts(); }; row.append(c); }
        box.append(row);
      }
      if (!shownPanels.length) { box.append(el('p', 'quiet', panels.length ? 'Every plot is switched off.' : 'No plot of this figure has values.')); continue; }
      const host = el('div'); box.append(host);
      chartBlock(host, {...fig, panels: shownPanels}, st, style, b, fig.id);
      const partial = panels.filter(p => p.missing.length && p.missing.length < p.series.length);
      for (const p of partial) box.append(el('p', 'sim-note warning', `${p.expression}: no values in sim-results.json for ${plural(p.missing.length, 'step')} (${p.missing.map(k => stepShort(b, k)).join('; ')}); those curves are not drawn.`));
    }
    if (missingPanels.length) box.append(el('p', 'sim-note warning', `Not drawn, no values in sim-results.json: ${missingPanels.join(', ')}.${b.files.csv ? ` Open ${b.files.csv} from the run directory (Open → File…, or drop it) to draw them.` : ''}`));
    return box;
  }
  function renderSpectra(b, st, style) {
    if (!b.spectra.length) return null;
    const box = el('section', 'sim-section'); box.append(el('h3', null, b.spectra.length > 1 ? 'Spectra' : 'Spectrum'));
    b.spectra.forEach((sp, k) => {
      const f = spectrumFigure(b, k); if (!f) return;
      box.append(el('p', 'sim-sub', `${f.expression} · ${f.coherent ? 'coherent over whole periods: levels in dBc, relative to the fundamental at each step; x in harmonics of f0' : 'windowed: levels in dB relative to 1 of its unit; x in Hz'}`));
      const series = f.series.filter(s => s.x).map(s => ({...s, stems: f.coherent}));
      if (!series.length) { box.append(el('p', 'sim-note warning', `No bins in sim-results.json for this spectrum.${b.files.spectrum_csv ? ` Open ${b.files.spectrum_csv} to draw it.` : ''}`)); return; }
      const all = series.flatMap(s => s.y).filter(Number.isFinite), peak = Math.max(...all);
      const yMin = Math.max(Math.min(...all), f.floor ? f.floor.value - 40 : -Infinity, peak - 240);
      const panel = {title: f.expression, units: 'dB', dimension: 'Gain', unitsLabel: f.units, phase: false, series, missing: f.missing, logY: false, canLogY: false, marks: [], refs: [], floor: f.floor, yMin, plot: -1, stems: f.coherent};
      const host = el('div'); box.append(host);
      chartBlock(host, {id: `${b.index}-spectrum-${k}`, x: {...f.x, label: f.x.name, logDefault: true, canLog: true}, panels: [panel], hint: 'Hover to read a bin · click to place cursors A and B · drag a box to zoom · Ctrl+wheel zooms · double-click resets'}, st, style, b, `spectrum-${k}`);
      if (f.floor) box.append(el('p', 'quiet', `Shaded: below the integration floor (${significant(f.floor.value, 3)} ${f.coherent ? 'dBc' : 'dB'}), where components are inside the solver's integration error and are not established.`));
      for (const n of f.notes) box.append(el('p', 'sim-note warning', n));
      const lines = sp.steps.map((s, i) => `${b.steps.length > 1 ? `${stepShort(b, i)}: ` : ''}${spectrumStepText(s)}`);
      if (lines.length === 1) box.append(el('p', 'quiet', lines[0])); else box.append(folded(`Analysis of each step (${lines.length})`, lines.map(t => el('p', 'quiet', t))));
    });
    return box;
  }
  function renderMeasures(b, st) {
    if (!b.measures.length) return null;
    const box = el('section', 'sim-section'); box.append(el('h3', null, `Measures (${b.measures.length})`));
    const rank = m => m.status === 'fail' || m.status === 'error' ? 0 : m.status === 'pass' ? 1 : 2;
    let measures = [...b.measures].sort((a, c) => rank(a) - rank(c));
    box.append(el('p', 'quiet', `Failing first, then the limited ones, then those without limits. Margin is the distance to the nearer limit${b.steps.length > 1 ? '; the worst step of each measure is marked' : ''}.`));
    if (b.measures.length > 20) {
      const input = el('input'); input.type = 'search'; input.placeholder = 'Filter measures…'; input.value = st.measureQuery; input.className = 'sim-filter';
      input.oninput = () => { st.measureQuery = input.value; const t = box.querySelector('.sim-measures-body'); t.replaceChildren(measuresTable(b, measures.filter(m => m.name.toLowerCase().includes(st.measureQuery.toLowerCase())))); };
      box.append(input);
    }
    if (st.measureQuery) measures = measures.filter(m => m.name.toLowerCase().includes(st.measureQuery.toLowerCase()));
    const body = el('div', 'sim-measures-body'); body.append(measuresTable(b, measures)); box.append(body);
    return box;
  }
  function measuresTable(b, measures) {
    const nameCell = m => { const c = td(m.name, null, m.expression); if (m.where) c.append(el('small', null, `where ${m.where}`)); return c; };
    const valueCell = (c, m) => {
      const cell = el('td', `num ${c.state}`); cell.append(el('span', 'sim-value', c.value));
      if (c.marginText) cell.append(el('small', null, c.marginText));
      else if (c.state === 'uncovered') cell.append(el('small', null, 'limit not applied (where)'));
      if (c.worst && b.steps.length > 1 && m.status !== 'no_limit') cell.append(el('small', 'sim-worst', 'worst'));
      cell.title = `${c.value} · limit ${c.limit}${c.marginText ? ` · ${c.marginText}` : ''}`; return cell;
    };
    const status = m => { const c = el('td'); c.append(chip(m.status === 'no_limit' ? 'no-limit' : m.status, m.status === 'no_limit' ? 'no limit' : m.status)); return c; };
    if (b.steps.length <= 8) {
      const head = ['measure', 'limit', 'status', ...b.steps.map((s, k) => { const h = el('th', 'num', b.steps.length > 1 ? stepShort(b, k) : 'value'); h.title = s.label; return h; })];
      return table(head, measures.map(m => { const cells = measureCells(m); return [nameCell(m), td(m.limits || 'none'), status(m), ...cells.map(c => valueCell(c, m))]; }), 'sim-measures');
    }
    const summary = table(['measure', 'limit', 'status', 'worst step', 'worst value', 'range over steps'], measures.map(m => {
      const cells = measureCells(m), w = m.worst_step !== null ? cells[m.worst_step] : null, vals = m.steps.map(s => s.value).filter(v => v !== null);
      return [nameCell(m), td(m.limits || 'none'), status(m), td(w ? stepShort(b, w.step) : '-', null, w ? b.steps[w.step].label : ''), w ? valueCell(w, m) : td('-'), td(vals.length ? `${V(Math.min(...vals), m.units, m.dimension)} .. ${V(Math.max(...vals), m.units, m.dimension)}` : '-', 'num')];
    }), 'sim-measures');
    const grid = () => table(['step', ...measures.map(m => { const h = el('th', 'num', m.name); h.title = `${m.expression} · ${m.limits || 'no limit'}`; return h; })],
      b.steps.map((s, k) => [td(stepShort(b, k), null, s.label), ...measures.map(m => valueCell(measureCells(m)[k], m))]), 'sim-measures sim-grid');
    const det = folded(`Every step (${b.steps.length} rows)`, []); det.addEventListener('toggle', () => { if (det.open && det.children.length < 2) det.append(grid()); }, {once: false});
    const wrap = el('div'); wrap.append(summary, det); return wrap;
  }
  function stepPicker(b, st, rerender, label = 'Step') {
    if (b.steps.length < 2) return null;
    const l = el('label', 'sim-step-pick'); l.append(`${label} `);
    const s = el('select'); b.steps.forEach((x, k) => { const o = el('option', null, x.label); o.value = k; s.append(o); }); s.value = String(st.step);
    s.onchange = () => { st.step = Number(s.value); rerender(); }; l.append(s); return l;
  }
  function renderNoise(b, st) {
    if (!b.noise.length) return null;
    const box = el('section', 'sim-section'); box.append(el('h3', null, 'Noise contributors'));
    for (const n of noiseAt(b, st.step)) {
      box.append(el('p', 'sim-sub', `${n.output}${b.steps.length > 1 ? ` at ${b.steps[st.step].label}` : ''}: ${formatQuantity(n.total_rms_v, 'V', 'Voltage')} rms from ${formatQuantity(n.from_hz, 'Hz', 'Frequency')} to ${formatQuantity(n.to_hz, 'Hz', 'Frequency')}`));
      const owners = noiseByOwner(n), fig = el('div', 'sim-svg'); fig.innerHTML = noiseSharesSvg(owners, n.total_rms_v); box.append(fig); // numbers and escaped text only
      box.append(folded(`Every generator (${n.contributors.length})`, table(['generator', 'part', 'rms at the output', 'share of power'], n.contributors.map(c => [c.contributor, c.owner, td(formatQuantity(c.rms_v, 'V', 'Voltage'), 'num'), td(`${significant((c.share ?? 0) * 100, 3)} %`, 'num')]))));
    }
    return box;
  }
  function renderPoles(b, st) {
    if (!b.pole_zero.length) return null;
    const box = el('section', 'sim-section'); box.append(el('h3', null, 'Poles and zeros'));
    const e = b.pole_zero.find(p => p.step === st.step) || b.pole_zero[0];
    box.append(el('p', `sim-sub${e.stable ? '' : ' fail'}`, `${e.stable ? 'Stable: no pole in the right half-plane' : 'Unstable: a pole in the right half-plane (the circuit oscillates or latches)'} · ${plural(e.poles.length, 'pole')}${e.transfer ? `, ${plural(e.zeros.length, 'zero')} of ${e.transfer}` : ''}${b.steps.length > 1 ? ` · ${b.steps[e.step]?.label}` : ''}`));
    const map = poleMapSvg(e), fig = el('div', 'sim-svg'); fig.innerHTML = map.svg; box.append(fig);
    if (map.origin) box.append(el('p', 'quiet', `${plural(map.origin, 'root')} at the origin, not on the log axis.`));
    const rows = [...e.poles.map(r => ['pole', r]), ...e.zeros.map(r => ['zero', r])].map(([k, r]) => [k, td(formatQuantity(r.frequency_hz, 'Hz', 'Frequency'), 'num'), td(r.damping === null ? '-' : significant(r.damping, 3), `num${r.right_half_plane ? ' fail' : ''}`), td(`${formatQuantity(r.re_hz, 'Hz', 'Frequency')} ${r.im_hz < 0 ? '-' : '+'} j${formatQuantity(Math.abs(r.im_hz), 'Hz', 'Frequency')}`, 'num'), r.nodes.join(', ')]);
    box.append(folded(`Every root (${rows.length})`, table(['', 'frequency', 'damping', 's / 2π', 'dominated by'], rows)));
    return box;
  }
  function renderVariation(b, st) {
    const v = b.variation; if (!v) return null;
    const box = el('section', 'sim-section'); const mc = v.method.kind === 'montecarlo';
    box.append(el('h3', null, mc ? 'Monte Carlo' : 'Worst case'));
    box.append(el('p', 'sim-sub', `${mc ? `${v.method.runs ?? '?'} runs per step, ${v.method.distribution || '?'} distribution, seed ${v.method.seed ?? '?'}` : 'every tolerance corner'} · ${plural(v.variables.length, 'varied quantity', 'varied quantities')}${v.yield !== null ? ` · yield ${significant(v.yield * 100, 4)} % of runs within every limit` : ''}. A measure's value in the table above is its worst run.`));
    box.append(folded('Varied quantities', el('p', 'quiet', v.variables.join(', ') || 'none listed')));
    const rows = variationRows(b, st.step); if (!rows.length) { box.append(el('p', 'quiet', 'No variation recorded at this step.')); return box; }
    if (mc) {
      const grid = el('div', 'sim-hists');
      for (const r of [...rows].sort((a, c) => Number(c.limit.min !== null || c.limit.max !== null) - Number(a.limit.min !== null || a.limit.max !== null))) {
        const h = histogram(r.values, r.limit); if (!h) continue;
        const card = el('figure', 'sim-hist-card'), m = r.measure;
        const cap = el('figcaption'); cap.append(el('strong', null, r.name), el('span', 'quiet', `${r.yield !== null ? `yield ${significant(r.yield * 100, 4)} % · ` : ''}mean ${V(r.mean, m.units, m.dimension)} · std ${V(r.std, m.units, m.dimension)} · nominal ${V(r.nominal, m.units, m.dimension)}`));
        const span = h.hi - h.lo, off = [['min', r.limit.min], ['max', r.limit.max]].filter(([, v]) => v !== null && (v < h.lo - span * 0.5 || v > h.hi + span * 0.5));
        if (off.length) cap.append(el('span', 'quiet', `limit ${off.map(([side, v]) => `${side} ${V(v, m.units, m.dimension)}`).join(', ')}: far beyond the runs, not drawn`));
        else if (r.limit.min === null && r.limit.max === null) cap.append(el('span', 'quiet', 'no limit'));
        const svg = el('div', 'sim-svg'); svg.innerHTML = histogramSvg(h, r); card.append(cap, svg); grid.append(card);
      }
      box.append(grid);
    } else {
      box.append(table(['measure', 'nominal', 'lowest', 'highest', 'yield', 'largest sensitivity'], rows.map(r => {
        const m = r.measure, sens = Object.entries(r.sensitivity || {}).sort((a, c) => Math.abs(c[1]) - Math.abs(a[1]));
        return [r.name, td(V(r.nominal, m.units, m.dimension), 'num'), td(V(r.min, m.units, m.dimension), `num${r.limit.min !== null && r.min < r.limit.min ? ' fail' : ''}`), td(V(r.max, m.units, m.dimension), `num${r.limit.max !== null && r.max > r.limit.max ? ' fail' : ''}`), td(r.yield === null ? '-' : `${significant(r.yield * 100, 4)} %`, 'num'), sens.length ? `${sens[0][0]} ${V(sens[0][1], m.units, m.dimension)}` : '-'];
      })));
      for (const r of rows) {
        const m = r.measure, corner = c => c ? Object.entries(c.x).filter(([, x]) => x).map(([k, x]) => `${k} ${x > 0 ? 'high' : 'low'}`).join(', ') || 'all nominal' : '-';
        const sens = Object.entries(r.sensitivity || {}).sort((a, c) => Math.abs(c[1]) - Math.abs(a[1]));
        box.append(folded(`${r.name}: corners and sensitivities`, [el('p', 'quiet', `Lowest ${V(r.low_corner?.value ?? r.min, m.units, m.dimension)} at ${corner(r.low_corner)}.`), el('p', 'quiet', `Highest ${V(r.high_corner?.value ?? r.max, m.units, m.dimension)} at ${corner(r.high_corner)}.`),
          table(['quantity', 'change over its tolerance'], sens.map(([k, x]) => [k, td(V(x, m.units, m.dimension), 'num')]))]));
      }
    }
    return box;
  }
  function renderRails(b, st) {
    const r = railsAt(b, st.step); const box = el('section', 'sim-section');
    if (r.supplies === null && r.stress === null && r.pins === null) return null;
    box.append(el('h3', null, 'Rails and stress'));
    const kind = b.analysis.kind, when = kind === 'op' ? 'at the operating point' : ['ac', 'noise', 'loop', 'pz'].includes(kind) ? 'at the bias point' : kind === 'tran' ? 'over the recorded span' : 'over the sweep';
    box.append(el('p', 'quiet', `Values ${when}${b.steps.length > 1 ? ` of ${b.steps[st.step].label}` : ''}${r.from !== null ? `; the same bias point as ${b.steps[r.from].label}, whose values these are` : ''}.`));
    const at = (v, s) => v === null || v === undefined ? '' : ` at ${formatQuantity(v, b.axis?.units || 's', b.axis?.dimension || 'Time', {digits: 3})}`;
    if (r.supplies === null) box.append(el('p', 'quiet', 'Supply currents are not recorded in this file.'));
    else if (!r.supplies.length) box.append(el('p', 'quiet', 'No supply is driven in this bench.'));
    else box.append(table(['supply', 'net', 'voltage', 'driven by', kind === 'tran' ? 'mean' : 'current', 'lowest', 'highest'], r.supplies.map(s => [s.supply, s.net, td(formatQuantity(s.voltage_v, 'V', 'Voltage'), 'num'), s.driven_by || 'source',
      td(s.mean_a === null || s.mean_a === undefined ? '-' : formatQuantity(s.mean_a, 'A', 'Current'), 'num'), td(`${formatQuantity(s.min_a, 'A', 'Current')}${kind === 'op' ? '' : at(s.min_at)}`, 'num'), td(`${formatQuantity(s.max_a, 'A', 'Current')}${kind === 'op' ? '' : at(s.max_at)}`, 'num')]), 'sim-rails'));
    if (r.stress?.length) {
      const unit = u => ({W: ['W', 'Power'], V: ['V', 'Voltage'], A: ['A', 'Current']})[u] || [u, null];
      box.append(el('h4', null, 'Component stress'));
      box.append(table(['component', 'quantity', 'mean', 'lowest', 'highest'], r.stress.map(s => { const [u, d] = unit(s.units); return [s.component, `${s.quantity}${s.pin ? ` (${s.pin})` : ''}`, td(s.mean === null || s.mean === undefined ? '-' : formatQuantity(s.mean, u, d), 'num'), td(`${formatQuantity(s.min, u, d)}${at(s.min_at)}`, 'num'), td(`${formatQuantity(s.max, u, d)}${at(s.max_at)}`, 'num')]; })));
      box.append(el('p', 'quiet', 'Recorded for parts that declare a stress rating; copper check --sim-results judges them against the board\'s ratings.'));
    }
    if (r.pins?.length) box.append(folded(`Pin voltages (${r.pins.length})`, table(['pin', 'net', 'fidelity', 'lowest', 'highest'], r.pins.map(p => [p.pin, p.net, p.fidelity, td(`${formatQuantity(p.min_v, 'V', 'Voltage')}${at(p.min_at)}`, 'num'), td(`${formatQuantity(p.max_v, 'V', 'Voltage')}${at(p.max_at)}`, 'num')]))));
    return box;
  }
  function renderSolver(b) {
    const box = el('section', 'sim-section'); box.append(el('h3', null, 'Models and solver'));
    box.append(el('p', 'quiet', `${fidelityLine(b)}.`));
    box.append(folded(`Models (${b.models.length})`, table(['fidelity', 'model', 'components and supplies', 'declared but not used by this analysis'], modelGroups(b).map(g => [g.fidelity, g.model, g.names.join(', '), g.inactive.join(', ')]))));
    const tr = b.steps.filter(s => s.transient);
    if (tr.length) box.append(folded('Transient solver work', table(['step', 'accepted', 'rejected', 'Newton', 'smallest step', 'largest step', 'steady state'], tr.map(s => { const t = s.transient; return [s.label, td(String(t.accepted), 'num'), td(String(t.rejected), 'num'), td(String(t.newton), 'num'), td(formatQuantity(t.smallest_s, 's', 'Time'), 'num'), td(formatQuantity(t.largest_s, 's', 'Time'), 'num'),
      t.steady_fallback ? td(`fallback: ${t.steady_fallback}`, 'fail') : t.steady_iterations ? `${t.steady_iterations} iterations, ${t.steady_periods} periods, residual ${significant(t.steady_residual ?? NaN, 3)}` : '-']; }))));
    if (b.timing) box.append(folded('Timing', el('p', 'quiet', `Wall time ${formatQuantity(b.timing.wall_s, 's', 'Time')}.`)));
    return box;
  }
  function renderBench(b) {
    const d = els.detail, st = stateOf(b), style = stepStyles(b);
    if (st.step >= b.steps.length) st.step = 0;
    const head = el('div', 'sim-head'); head.append(el('h2', null, b.name), chip(b.verdict, verdictText(b))); d.append(head);
    d.append(el('p', 'sim-sub', `${analysisText(b)}${b.steps.length > 1 ? ` · ${plural(b.steps.length, 'step')}` : ''}${b.module ? ` · module ${b.module}` : ''} · ${verdictLine(b)}`));
    const src = el('p', 'quiet', `Bench source ${basename(b.file)}${b.files.html ? ` · CLI page ${b.files.html}` : ''}${b.files.csv ? ` · vectors ${b.files.csv}` : ''}${b.files.spectrum_csv ? ` · spectra ${b.files.spectrum_csv}` : ''}`); src.title = b.file; d.append(src);
    const failing = b.measures.filter(m => m.status === 'fail');
    if (failing.length) { const m = failing[0], c = measureCells(m)[m.worst_step ?? 0]; d.append(el('p', 'sim-badge', `${m.name} fails: ${c.value}${b.steps.length > 1 ? ` at ${b.steps[c.step].label}` : ''} (${m.limits}; ${c.marginText})${failing.length > 1 ? `; ${failing.length - 1} more fail` : ''}`)); }
    for (const n of b.notes) d.append(el('p', `sim-note ${n.level}`, n.text));
    if (b.error) return;
    const figures = el('div', 'sim-figures'); d.append(figures);
    const drawFigures = () => {
      for (const c of charts) c.destroy(); charts = []; figures.replaceChildren();
      let legend;
      // Toggling steps keeps each chart's zoom and cursors: only the legend is rebuilt.
      const refreshSteps = () => { const next = stepLegend(b, st, style, refreshSteps); legend.replaceWith(next); legend = next; for (const c of charts) c.setHidden(st.hidden); };
      legend = stepLegend(b, st, style, refreshSteps);
      const plots = renderPlots(b, st, style, drawFigures), spectra = renderSpectra(b, st, style);
      if (plots || spectra) figures.append(legend);
      if (plots) figures.append(plots);
      if (spectra) figures.append(spectra);
      if (!plots && !spectra && b.analysis.kind !== 'op' && b.analysis.kind !== 'pz') figures.append(el('p', 'quiet', 'This bench plots nothing.'));
    };
    drawFigures();
    d.append(renderMeasures(b, st) || el('p', 'quiet', 'No measures.'));
    const tables = el('div'); d.append(tables);
    const drawTables = () => {
      tables.replaceChildren();
      const picker = stepPicker(b, st, drawTables, 'Tables below show step');
      const parts = [renderNoise(b, st), renderPoles(b, st), renderVariation(b, st), renderRails(b, st)].filter(Boolean);
      if (picker && parts.length) tables.append(picker);
      tables.append(...parts, renderSolver(b));
    };
    drawTables();
  }
  function renderDetail() {
    for (const c of charts) c.destroy(); charts = []; els.detail.replaceChildren(); pruneCharts();
    if (!model) return;
    const b = selected === null ? null : model.benches[selected];
    if (b) renderBench(b); else renderOverview();
    els.detail.scrollTop = 0;
  }
  function select(index) { selected = index; renderList(); renderDetail(); onChange(); els.list.querySelector('.sim-item[aria-pressed=true]')?.scrollIntoView?.({block: 'nearest'}); }
  els.search.oninput = () => { query = els.search.value.trim(); if (model) renderList(); };
  for (const b of els.filters.querySelectorAll('[data-filter]')) b.onclick = () => { filter = b.dataset.filter; if (model) renderList(); };
  return {
    load(m) { model = m; selected = null; benchState.clear(); query = ''; els.search.value = ''; filter = 'all'; renderList(); renderDetail(); onChange(); },
    clear() { model = null; selected = null; els.list.replaceChildren(); renderDetail(); onChange(); },
    hasModel: () => !!model, model: () => model,
    select(name) { const i = name === null ? null : model?.benches.findIndex(b => b.name === name); if (i === -1 || i === undefined) return false; select(i); return true; },
    selected: () => selected === null ? null : model.benches[selected]?.name,
    /** Fill vectors the JSON lacks from a CSV copper sim wrote beside it. */
    addCsv(name, text) { if (!model) throw Error(`Open the sim-results.json of the run before ${name}.`); const r = mergeCsv(model, name, text); if (selected === r.bench.index || selected === null) renderDetail(); renderList(); return r; },
    redraw() { for (const c of charts) c.redraw(); },
  };
}
