/* Simulation results from `copper sim` (`sim-results.json`, schema `copperscript-sim/v1`).
 * Pure data, no DOM, so Node's built-in tests exercise it. The authoritative description of every
 * field is CopperScript's docs/sim-results-schema.md. Reading never throws on content: a field
 * that is missing (an older v1 file) gives an empty value and a note saying what is absent. */
export const SIM_PREFIX = 'copperscript-sim/';
export const SIM_SCHEMA = 'copperscript-sim/v1';
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const num = v => typeof v === 'number' && Number.isFinite(v) ? v : null;
const int = (v, d = null) => Number.isInteger(v) ? v : d;
const str = (v, d = '') => typeof v === 'string' ? v : d;
const list = v => Array.isArray(v) ? v : [];
const strings = v => list(v).filter(s => typeof s === 'string');
/** A vector with NaN where the document has null (not finite there). */
const vector = v => Array.isArray(v) ? v.map(x => typeof x === 'number' && Number.isFinite(x) ? x : NaN) : null;
const plural = (k, word, many = `${word}s`) => `${k} ${k === 1 ? word : many}`;

// ---- Numbers and units ------------------------------------------------------------------------
/** Fixed point with `digits` significant digits and no trailing zeros (`1.25`, `938`, `0.0235`), as copper sim prints. */
export function significant(value, digits = 4) {
  if (!Number.isFinite(value)) return Number.isNaN(value) ? 'NaN' : String(value);
  if (value === 0) return '0';
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  const decimals = Math.min(20, Math.max(0, digits - 1 - magnitude));
  let text = value.toFixed(decimals);
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');
  return text === '-0' ? '0' : text;
}
export function scientific(value, digits = 4) {
  const [m, e] = value.toExponential(digits - 1).split('e');
  return `${m.includes('.') ? m.replace(/0+$/, '').replace(/\.$/, '') : m}e${Number(e)}`;
}
const UNITS = {
  voltage: [['pV', 1e-12], ['nV', 1e-9], ['uV', 1e-6], ['mV', 1e-3], ['V', 1], ['kV', 1e3]],
  current: [['fA', 1e-15], ['pA', 1e-12], ['nA', 1e-9], ['uA', 1e-6], ['mA', 1e-3], ['A', 1], ['kA', 1e3]],
  time: [['fs', 1e-15], ['ps', 1e-12], ['ns', 1e-9], ['us', 1e-6], ['ms', 1e-3], ['s', 1]],
  frequency: [['mHz', 1e-3], ['Hz', 1], ['kHz', 1e3], ['MHz', 1e6], ['GHz', 1e9], ['THz', 1e12]],
  resistance: [['mohm', 1e-3], ['ohm', 1], ['kohm', 1e3], ['Mohm', 1e6], ['Gohm', 1e9], ['Tohm', 1e12]],
  capacitance: [['fF', 1e-15], ['pF', 1e-12], ['nF', 1e-9], ['uF', 1e-6], ['mF', 1e-3], ['F', 1]],
  inductance: [['pH', 1e-12], ['nH', 1e-9], ['uH', 1e-6], ['mH', 1e-3], ['H', 1]],
  power: [['pW', 1e-12], ['nW', 1e-9], ['uW', 1e-6], ['mW', 1e-3], ['W', 1], ['kW', 1e3]],
  charge: [['fC', 1e-15], ['pC', 1e-12], ['nC', 1e-9], ['uC', 1e-6], ['mC', 1e-3], ['C', 1]],
  energy: [['pJ', 1e-12], ['nJ', 1e-9], ['uJ', 1e-6], ['mJ', 1e-3], ['J', 1]],
  voltagenoisedensity: [['pV/rtHz', 1e-12], ['nV/rtHz', 1e-9], ['uV/rtHz', 1e-6], ['mV/rtHz', 1e-3], ['V/rtHz', 1]],
  currentnoisedensity: [['fA/rtHz', 1e-15], ['pA/rtHz', 1e-12], ['nA/rtHz', 1e-9], ['uA/rtHz', 1e-6], ['mA/rtHz', 1e-3], ['A/rtHz', 1]],
  slewrate: [['V/s', 1], ['V/ms', 1e3], ['V/us', 1e6], ['V/ns', 1e9]],
  gain: [['dB', 1]], angle: [['deg', 1]], temperature: [['K', 1]],
};
UNITS.impedance = UNITS.resistance;
const BY_TEXT = {V: 'voltage', A: 'current', s: 'time', Hz: 'frequency', '1/s': 'frequency', ohm: 'resistance', 'V/A': 'resistance', F: 'capacitance', H: 'inductance', W: 'power', C: 'charge', J: 'energy',
  dB: 'gain', deg: 'angle', K: 'temperature', 'V*s^(1/2)': 'voltagenoisedensity', 'V/rtHz': 'voltagenoisedensity', 'A*s^(1/2)': 'currentnoisedensity', 'A/rtHz': 'currentnoisedensity', 'V/s': 'slewrate'};
const dimensionKey = (units, dimension) => {
  const d = typeof dimension === 'string' ? dimension.toLowerCase().replace(/[^a-z]/g, '') : '';
  if (UNITS[d]) return d;
  if (d === 'ratio' || units === '1') return 'ratio';
  return BY_TEXT[units] || null;
};
/** The base text of units without a named dimension, for people: `V/A*s^(1/2)` reads `V/A/rtHz`. */
export function displayBase(units) {
  const u = str(units);
  if (u === 's^(1/2)') return '1/rtHz';
  if (u.endsWith('*s^(1/2)')) return `${u.slice(0, -8)}/rtHz`;
  return u === '1' ? '' : u;
}
/** How values of these units are written: a list of [unit, scale] to pick from, percent, or a fixed text. */
export function unitSystem(units, dimension) {
  const key = dimensionKey(units, dimension);
  if (key === 'ratio') return {kind: 'percent', label: '%', choices: [['%', 0.01]]};
  if (key && UNITS[key]) return {kind: 'named', key, label: UNITS[key].find(u => u[1] === 1)?.[0] || UNITS[key][0][0], choices: UNITS[key]};
  return {kind: 'plain', label: displayBase(units), choices: [[displayBase(units), 1]]};
}
/** The unit among `system.choices` for a magnitude: the largest scale not above it (milliohm only below 1 ohm). */
export function unitFor(system, magnitude) {
  let choices = system.choices;
  if (system.key === 'resistance' || system.key === 'impedance') choices = choices.filter(c => c[0] !== 'mohm' || magnitude < 1);
  if (!(magnitude > 0) || !Number.isFinite(magnitude)) return choices.find(c => c[1] === 1) || choices[0];
  for (let i = choices.length - 1; i >= 0; i--) if (magnitude >= choices[i][1] * 0.9995) return choices[i];
  return choices[0];
}
/** A value in engineering units: `15 uA`, `1.59 kHz`, `-3.01 dB`, `0.23 %`; `never` for a never measure. */
export function formatQuantity(value, units, dimension, {digits = 4, never = false} = {}) {
  if (never) return 'never';
  if (value === null || value === undefined || Number.isNaN(value)) return '-';
  if (!Number.isFinite(value)) return String(value);
  const system = unitSystem(units, dimension);
  if (system.kind === 'plain') return `${Math.abs(value) >= 1e5 || (value !== 0 && Math.abs(value) < 1e-3) ? scientific(value, digits) : significant(value, digits)}${system.label ? ` ${system.label}` : ''}`;
  if (system.kind === 'percent') {
    const p = value * 100;
    return `${p !== 0 && Math.abs(p) < 1e-4 ? scientific(p, digits) : significant(p, digits)} %`;
  }
  let [unit, scale] = unitFor(system, Math.abs(value));
  let text = significant(value / scale, digits);
  if (Math.abs(Number(text)) >= 1000) { const next = unitFor(system, Math.abs(Number(text) * scale)); if (next[0] !== unit) { [unit, scale] = next; text = significant(value / scale, digits); } }
  return `${text} ${unit}`;
}
export const hertz = hz => formatQuantity(hz, 'Hz', 'Frequency', {digits: 4});
const seconds = t => formatQuantity(t, 's', 'Time', {digits: 3});

// ---- Reading the document ---------------------------------------------------------------------
/** `sim-results` for a document of any copperscript-sim schema (supported or not), else null. */
export function simDocumentKind(value) {
  return isObject(value) && typeof value.schema === 'string' && value.schema.startsWith(SIM_PREFIX) ? 'sim-results' : null;
}
const STATUS = new Set(['pass', 'fail', 'error']);
function readStep(s, k, kind) {
  const stepped = {};
  for (const [name, q] of Object.entries(isObject(s.stepped) ? s.stepped : {})) stepped[name] = isObject(q) ? {value: str(q.value), unit: str(q.unit), base_value: str(q.base_value)} : {value: String(q), unit: '', base_value: ''};
  const t = isObject(s.transient) ? s.transient : null;
  return {
    index: int(s.index, k), label: str(s.label) || 'nominal', stepped, params: isObject(s.params) ? s.params : {}, analysis: isObject(s.analysis) ? s.analysis : {},
    x: vector(s.x) || [],
    transient: t && {accepted: int(t.accepted_steps, 0), rejected: int(t.rejected_steps, 0), newton: int(t.newton_iterations, 0), factorizations: int(t.factorizations, 0), breakpoints: int(t.breakpoints, 0),
      smallest_s: num(t.smallest_step_s), largest_s: num(t.largest_step_s), steady_iterations: int(t.steady_iterations, 0), steady_periods: int(t.steady_periods, 0),
      steady_residual: num(t.steady_residual), steady_fallback: typeof t.steady_fallback === 'string' ? t.steady_fallback : null, noise_generators: int(t.noise_generators, 0)},
    // null: the field is absent (a document written before it); []: recorded and empty.
    pins: Array.isArray(s.pins) ? s.pins.filter(isObject) : null,
    supplies: Array.isArray(s.supplies) ? s.supplies.filter(isObject) : null,
    stress: Array.isArray(s.stress) ? s.stress.filter(isObject) : null,
    bias_step: int(s.bias_step),
    kind,
  };
}
function readMeasure(m, steps) {
  const rows = list(m.steps);
  return {
    name: str(m.name, '?'), expression: str(m.expression), units: str(m.units, '1'), dimension: typeof m.dimension === 'string' ? m.dimension : null,
    limits: str(m.limits), where: typeof m.where === 'string' ? m.where : null, covered_steps: list(m.covered_steps).filter(Number.isInteger),
    mark: isObject(m.mark) && ['lines', 'window'].includes(m.mark.kind) && Number.isInteger(m.mark.plot) ? {kind: m.mark.kind, plot: m.mark.plot} : null,
    worst_step: int(m.worst_step), status: ['pass', 'fail', 'error', 'no_limit'].includes(m.status) ? m.status : 'no_limit',
    steps: steps.map((_, k) => {
      const r = isObject(rows[k]) ? rows[k] : {};
      return {value: num(r.value), never: r.never === true, min: num(r.min), max: num(r.max), pass: typeof r.pass === 'boolean' ? r.pass : null, covered: r.covered !== false, at: num(r.at)};
    }),
  };
}
function readBench(b, i, notes) {
  const analysis = isObject(b.analysis) ? b.analysis : {kind: 'op'};
  const kind = str(analysis.kind, 'op');
  const steps = list(b.steps).filter(isObject).map((s, k) => readStep(s, k, kind));
  const plots = list(b.plots).filter(isObject).map((p, index) => ({
    index, expression: str(p.expression, `plot ${index + 1}`), units: str(p.units, '1'), dimension: typeof p.dimension === 'string' ? p.dimension : null,
    steps: steps.map((s, k) => { const v = vector(list(p.steps)[k]?.values); return v && v.length === s.x.length && v.length ? v : null; }),
  }));
  const spectra = list(b.spectra).filter(isObject).map((p, index) => ({
    index, expression: str(p.expression, `spectrum ${index + 1}`), units: str(p.units, '1'), dimension: typeof p.dimension === 'string' ? p.dimension : null, coherent: p.coherent === true,
    steps: steps.map((_, k) => {
      const s = list(p.steps)[k];
      if (!isObject(s)) return null;
      const f = vector(s.frequency_hz), a = vector(s.amplitude);
      return {fundamental_hz: num(s.fundamental_hz), periods: int(s.periods, 0), window: str(s.window), samples: int(s.samples, 0), start_s: num(s.start_s), span_s: num(s.span_s),
        uniform_steps: s.uniform_steps === true, integration_floor: num(s.integration_floor), frequency_hz: f && a && f.length === a.length && f.length ? f : null, amplitude: f && a && f.length === a.length && f.length ? a : null};
    }),
  }));
  const v = isObject(b.variation) ? b.variation : null;
  const bench = {
    index: i, name: str(b.name, `bench ${i + 1}`), bench: str(b.bench) || str(b.name, `bench ${i + 1}`), section: typeof b.section === 'string' ? b.section : null,
    board: str(b.board), module: typeof b.module === 'string' ? b.module : null, file: str(b.file),
    status: STATUS.has(b.status) ? b.status : 'error', error: typeof b.error === 'string' ? b.error : null,
    files: isObject(b.files) ? {html: str(b.files.html) || null, csv: str(b.files.csv) || null, spectrum_csv: str(b.files.spectrum_csv) || null} : {html: null, csv: null, spectrum_csv: null},
    analysis: {...analysis, kind, stepped: strings(analysis.stepped)},
    axis: isObject(b.axis) ? {quantity: str(b.axis.quantity), name: str(b.axis.name), units: str(b.axis.units), dimension: typeof b.axis.dimension === 'string' ? b.axis.dimension : null, scale: b.axis.scale === 'log' ? 'log' : 'linear'} : null,
    models: list(b.models).filter(isObject).map(m => ({name: str(m.name, '?'), kind: str(m.kind, 'component'), part: typeof m.part === 'string' ? m.part : null, bench: m.bench === true, fidelity: str(m.fidelity, 'unknown'), model: str(m.model), inactive: strings(m.inactive_parameters)})),
    steps, plots, spectra,
    measures: list(b.measures).filter(isObject).map(m => readMeasure(m, steps)),
    noise: list(b.noise).filter(isObject).map(n => ({step: int(n.step, 0), output: str(n.output), from_hz: num(n.from_hz), to_hz: num(n.to_hz), total_rms_v: num(n.total_rms_v),
      contributors: list(n.contributors).filter(isObject).map(c => ({contributor: str(c.contributor, '?'), owner: str(c.owner), rms_v: num(c.rms_v), share: num(c.share)}))})),
    pole_zero: list(b.pole_zero).filter(isObject).map(p => {
      const root = r => ({re_hz: num(r.re_hz), im_hz: num(r.im_hz), frequency_hz: num(r.frequency_hz), damping: num(r.damping), right_half_plane: r.right_half_plane === true, refined: r.refined === true, real: r.real === true, origin: r.origin === true, nodes: strings(r.nodes)});
      return {step: int(p.step, 0), stable: p.stable !== false, unknowns: int(p.unknowns), infinite_eigenvalues: int(p.infinite_eigenvalues), transfer: typeof p.transfer === 'string' ? p.transfer : null, poles: list(p.poles).filter(isObject).map(root), zeros: list(p.zeros).filter(isObject).map(root)};
    }),
    variation: v && {
      method: isObject(v.method) ? {kind: v.method.kind === 'worstcase' ? 'worstcase' : 'montecarlo', runs: int(v.method.runs), seed: int(v.method.seed), distribution: typeof v.method.distribution === 'string' ? v.method.distribution : null} : {kind: 'montecarlo', runs: null, seed: null, distribution: null},
      variables: strings(v.variables), yield: num(v.yield),
      steps: list(v.steps).filter(isObject).map((s, k) => ({index: int(s.index, k), runs: int(s.runs, 0), yield: num(s.yield), measures: list(s.measures).filter(isObject).map(m => ({
        name: str(m.name, '?'), nominal: num(m.nominal), min: num(m.min), max: num(m.max), yield: num(m.yield), worst_run: int(m.worst_run), mean: num(m.mean), std: num(m.std), values: vector(m.values) || [],
        low_corner: isObject(m.low_corner) ? {value: num(m.low_corner.value), x: isObject(m.low_corner.x) ? m.low_corner.x : {}} : null,
        high_corner: isObject(m.high_corner) ? {value: num(m.high_corner.value), x: isObject(m.high_corner.x) ? m.high_corner.x : {}} : null,
        sensitivity: isObject(m.sensitivity) ? Object.fromEntries(Object.entries(m.sensitivity).filter(([, x]) => num(x) !== null)) : null}))})),
    },
    timing: isObject(b.timing) ? b.timing : null,
    notes: [],
  };
  bench.counts = countMeasures(bench);
  bench.verdict = bench.status === 'error' ? 'error' : bench.status === 'fail' || bench.counts.failing ? 'fail' : bench.counts.limited ? 'pass' : 'no-limit';
  bench.notes = benchNotes(bench);
  if (steps.some(s => s.pins === null)) notes.add('pins');
  if (steps.some(s => s.supplies === null)) notes.add('supplies');
  return bench;
}
const hasLimits = m => m.limits !== '' || m.steps.some(s => s.min !== null || s.max !== null);
function countMeasures(bench) {
  const limited = bench.measures.filter(hasLimits);
  return {measures: bench.measures.length, limited: limited.length, failing: limited.filter(m => m.status === 'fail' || m.status === 'error').length, noLimit: bench.measures.length - limited.length};
}
/**
 * Read a parsed `sim-results.json`. A document of another copperscript-sim version, or no simulation
 * results at all, gives a model with `error` set and no benches; nothing throws.
 */
export function readSim(value, {name = null, sha256 = null} = {}) {
  const file = name || 'This file';
  const model = {schema: isObject(value) && typeof value.schema === 'string' ? value.schema : null, file: name, sha256, error: null, notes: [], benches: [],
    board: '', status: 'error', solver: null, source: null};
  if (!simDocumentKind(value)) { model.error = `${file} is not a copper sim results file (schema ${SIM_SCHEMA}).`; return model; }
  if (value.schema !== SIM_SCHEMA) {
    const older = /^copperscript-sim\/v0\./.test(value.schema);
    model.error = `${file} has schema ${value.schema}; this view reads ${SIM_SCHEMA} only. ${older ? 'Run `copper sim` again with a current CopperScript to write v1.' : 'It was written by a newer CopperScript than this CopperReview understands; update CopperReview.'}`;
    return model;
  }
  model.board = str(value.board);
  model.status = STATUS.has(value.status) ? value.status : 'error';
  model.solver = isObject(value.solver) ? {name: str(value.solver.name), version: str(value.solver.version), method: str(value.solver.method)} : null;
  model.source = isObject(value.source) ? {board_file: str(value.source.board_file), design_sha256: str(value.source.design_sha256), benches_sha256: str(value.source.benches_sha256)} : null;
  const absent = new Set();
  model.benches = list(value.benches).filter(isObject).map((b, i) => readBench(b, i, absent));
  if (!model.source) model.notes.push('No `source` record (a file written before it existed): the board file and the design and bench digests are unknown.');
  if (absent.has('pins') || absent.has('supplies')) model.notes.push('Pin voltages and supply currents are not recorded in this file (written before v1 added them); rails and stress cannot be shown.');
  if (!model.benches.length) model.notes.push('The file holds no benches.');
  return model;
}

// ---- Words for a bench ------------------------------------------------------------------------
const range = (values, show) => { const v = values.filter(x => x !== null && x !== undefined); if (!v.length) return null; const lo = Math.min(...v), hi = Math.max(...v); return lo === hi ? show(lo) : `${show(lo)}..${show(hi)}`; };
const field = (bench, key) => bench.analysis.stepped.includes(key) ? bench.steps.map(s => num(s.analysis[key])) : [num(bench.analysis[key])];
/** The analysis in words, as copper sim writes it: `ac 1 kHz to 1 MHz, 20 points per decade`. */
export function analysisText(bench) {
  const a = bench.analysis, f = key => range(field(bench, key), hertz), ppd = a.points_per_decade ?? bench.steps[0]?.analysis.points_per_decade;
  switch (a.kind) {
    case 'op': return 'operating point';
    case 'ac': return `ac ${f('from_hz')} to ${f('to_hz')}${ppd ? `, ${ppd} points per decade` : ''}`;
    case 'loop': return `loop gain at ${a.probe || '?'}${a.net ? ` (net ${a.net})` : ''} ${f('from_hz')} to ${f('to_hz')}${ppd ? `, ${ppd} points per decade` : ''}`;
    case 'noise': return `noise of ${strings(a.outputs).join(', ') || '?'}${a.input ? ` referred to ${a.input},` : ''} ${f('from_hz')} to ${f('to_hz')}${ppd ? `, ${ppd} points per decade` : ''}${range(field(bench, 'temperature_k'), k => `${significant(k, 5)} K`) ? `, ${range(field(bench, 'temperature_k'), k => `${significant(k, 5)} K`)}` : ''}`;
    case 'tran': {
      const stop = range(field(bench, 'stop_s'), seconds), start = field(bench, 'start_s').some(s => s > 0) ? range(field(bench, 'start_s'), seconds) : null;
      const step = range(field(bench, 'max_step_s'), seconds), steady = range(field(bench, 'steady_period_s'), seconds);
      return `tran 0 to ${stop || '?'}${start ? `, recorded from ${start}` : ''}${step ? `, max step ${step}` : ''}${steady ? `, periodic steady state of ${steady}` : ''}${num(a.noise_seed) !== null ? `, with noise (seed ${a.noise_seed})` : ''}`;
    }
    case 'dc': { const show = v => formatQuantity(v, a.units, a.dimension); return `dc sweep of ${a.sweep || '?'} from ${range(field(bench, 'from'), show)} to ${range(field(bench, 'to'), show)}, ${range(field(bench, 'points'), String)} points`; }
    case 'pz': return a.input && a.output ? `poles, and the zeros of ${a.output} per unit of ${a.input}` : 'poles';
    default: return a.kind;
  }
}
const VERDICT = {pass: 'pass', fail: 'fail', error: 'error', 'no-limit': 'no limits'};
export const verdictText = bench => VERDICT[bench.verdict];
/** `3 of 3 limited measures pass` / `1 of 4 limited measures fail` / `no measure has limits`. */
export function verdictLine(bench) {
  const c = bench.counts;
  if (bench.verdict === 'error') return `could not be solved: ${bench.error || 'no reason given'}`;
  if (!c.limited) return c.measures ? `${plural(c.measures, 'measure')}, none with limits: nothing is judged` : 'no measures';
  if (c.failing) return `${c.failing} of ${plural(c.limited, 'limited measure')} fail${c.noLimit ? ` · ${c.noLimit} without limits` : ''}`;
  return `${c.limited} of ${plural(c.limited, 'limited measure')} pass${c.noLimit ? ` · ${c.noLimit} without limits` : ''}`;
}
/** Benches grouped by declared bench, sections together, in file order. */
export function benchGroups(model) {
  const groups = [];
  for (const b of model.benches) { const last = groups[groups.length - 1]; if (last && last.name === b.bench && b.section !== null) last.benches.push(b); else groups.push({name: b.bench, benches: [b]}); }
  return groups;
}

// ---- Measures: value, limit and margin per step -----------------------------------------------
/** The tighter side of the limits at one step: amount > 0 inside (a pass), < 0 outside. null without limits or value. */
export function marginOf(s) {
  if (s.never || s.value === null) return null;
  const sides = [];
  if (s.min !== null) sides.push({side: 'min', amount: s.value - s.min});
  if (s.max !== null) sides.push({side: 'max', amount: s.max - s.value});
  return sides.length ? sides.reduce((a, b) => b.amount < a.amount ? b : a) : null;
}
/** `0.27 % under max`, `4.6 deg above min`; outside: `1.2 mV over max`, `3 dB below min`. */
export function marginText(margin, measure) {
  if (!margin) return '';
  const amount = formatQuantity(Math.abs(margin.amount), measure.units, measure.dimension, {digits: 3});
  if (Math.abs(margin.amount) === 0) return `at ${margin.side}`;
  return margin.side === 'max' ? `${amount} ${margin.amount > 0 ? 'under' : 'over'} max` : `${amount} ${margin.amount > 0 ? 'above' : 'below'} min`;
}
/** The limit at one step in words: `max 1 %`, `min 15 deg, max 1 V`, `-` without one. */
export function stepLimitText(s, measure) {
  const parts = [];
  if (s.min !== null) parts.push(`min ${formatQuantity(s.min, measure.units, measure.dimension)}`);
  if (s.max !== null) parts.push(`max ${formatQuantity(s.max, measure.units, measure.dimension)}`);
  return parts.join(', ') || '-';
}
/** Each step of a measure for the table: value, limit, margin and state (`pass`, `fail`, `uncovered`, `free`). */
export function measureCells(measure) {
  return measure.steps.map((s, k) => {
    const margin = s.covered ? marginOf(s) : null;
    const state = s.pass === false || (s.never && s.covered && (s.min !== null || s.max !== null)) ? 'fail' : s.pass === true ? 'pass' : !s.covered ? 'uncovered' : 'free';
    return {step: k, value: formatQuantity(s.value, measure.units, measure.dimension, {never: s.never}), limit: stepLimitText(s, measure), margin, marginText: marginText(margin, measure), state, worst: measure.worst_step === k};
  });
}
/** The failing limits of a run, worst first within a bench, error benches before them. */
export function failures(model) {
  const out = [];
  for (const b of model.benches) {
    if (b.verdict === 'error') { out.push({bench: b, error: b.error || 'could not be solved'}); continue; }
    for (const m of b.measures) {
      const cells = measureCells(m), failing = cells.filter(c => c.state === 'fail');
      if (!failing.length && m.status !== 'fail') continue;
      const worst = cells[m.worst_step ?? failing[0]?.step ?? 0] || failing[0];
      out.push({bench: b, measure: m, worst, failingSteps: failing.length, steps: m.steps.length, stepLabel: b.steps.length > 1 ? b.steps[worst?.step]?.label : null});
    }
  }
  return out;
}

// ---- Step styles: colour and dash per step, and the legend that explains them ------------------
export const STEP_COLORS = 8;
export const DASHES = [[], [8, 4], [2, 3], [10, 3, 2, 3]];
/** Stepped params that move together (each one's value decides the other's) form one factor. */
export function factors(bench) {
  const steps = bench.steps, names = Object.keys(steps[0]?.stepped || {});
  if (!names.length || steps.some(s => Object.keys(s.stepped).length !== names.length)) return [];
  const table = steps.map(s => names.map(n => s.stepped[n] ? `${s.stepped[n].value}${s.stepped[n].unit ? ` ${s.stepped[n].unit}` : ''}` : '?'));
  const determines = (a, b) => { const seen = new Map(); for (const row of table) { if (seen.has(row[a]) && seen.get(row[a]) !== row[b]) return false; seen.set(row[a], row[b]); } return true; };
  const groups = [];
  for (let i = 0; i < names.length; i++) { const g = groups.find(g => determines(g[0], i) && determines(i, g[0])); if (g) g.push(i); else groups.push([i]); }
  return groups.map(g => {
    const levels = [], of_step = table.map(row => { const text = g.map(i => row[i]).join(', '); let k = levels.indexOf(text); if (k < 0) { levels.push(text); k = levels.length - 1; } return k; });
    return {names: g.map(i => names[i]), levels, of_step};
  });
}
/**
 * Up to eight steps get a colour each (and a dash as the second encoding). Beyond eight, the factor with
 * the most levels up to eight sets the colour and another with up to four levels the dash; a factor with
 * more levels and nothing smaller is drawn on a ramp. `color[k]` is {palette: i} or {ramp: t}.
 */
export function stepStyles(bench) {
  const n = bench.steps.length, f = factors(bench);
  if (n <= STEP_COLORS) return {factors: f, colorFactor: null, dashFactor: null, ramp: false, color: bench.steps.map((_, k) => ({palette: k})), dash: bench.steps.map((_, k) => k % DASHES.length)};
  const byLevels = f.map((x, i) => [i, x.levels.length]).filter(([, l]) => l > 1);
  const fits = byLevels.filter(([, l]) => l <= STEP_COLORS).sort((a, b) => b[1] - a[1]);
  let colorFactor = fits[0]?.[0] ?? null, ramp = false;
  if (colorFactor === null && byLevels.length) { colorFactor = byLevels.sort((a, b) => b[1] - a[1])[0][0]; ramp = true; }
  const dashes = byLevels.filter(([i, l]) => i !== colorFactor && l <= DASHES.length).sort((a, b) => b[1] - a[1]);
  const dashFactor = dashes[0]?.[0] ?? null;
  const color = bench.steps.map((_, k) => colorFactor === null ? {palette: 0} : ramp ? {ramp: f[colorFactor].levels.length > 1 ? f[colorFactor].of_step[k] / (f[colorFactor].levels.length - 1) : 0} : {palette: f[colorFactor].of_step[k]});
  const dash = bench.steps.map((_, k) => dashFactor === null ? 0 : f[dashFactor].of_step[k]);
  return {factors: f, colorFactor, dashFactor, ramp, color, dash};
}
/** The short text of a step for legends: its stepped values, or its label. */
export function stepShort(bench, k) {
  const s = bench.steps[k], values = Object.values(s?.stepped || {}).map(q => `${q.value}${q.unit ? ` ${q.unit}` : ''}`);
  return values.length ? values.join(', ') : s?.label || `step ${k + 1}`;
}

// ---- Figures of plotted vectors ---------------------------------------------------------------
const isPhase = p => p.units === 'deg' || /angle/i.test(p.dimension || '');
const isNoiseDensity = p => /s\^\(1\/2\)|rtHz/.test(p.units) || /noisedensity/i.test(p.dimension || '');
const span = x => x.length ? x[x.length - 1] - x[0] : 0;
/** The share of a set of curves' change in the first tenth of their records (median over curves). */
function earlyShare(curves) {
  const shares = [];
  for (const [x, v] of curves) {
    if (x.length < 3) continue;
    const cut = x[0] + (x[x.length - 1] - x[0]) * 0.1; let early = 0, total = 0, lo = Infinity, hi = -Infinity;
    for (let i = 1; i < x.length; i++) { const d = Math.abs(v[i] - v[i - 1]); if (Number.isFinite(v[i])) { lo = Math.min(lo, v[i]); hi = Math.max(hi, v[i]); } if (!Number.isFinite(d)) continue; total += d; if (x[i] <= cut) early += d; }
    if (total > 0 && hi > lo) shares.push(early / total);
  }
  shares.sort((a, b) => a - b);
  return shares.length ? shares[shares.length >> 1] : 0;
}
/** When the first curve leaves its start (by 1 % of its range, above t = 0) and when the last settles at its end. */
function activity(curves) {
  let moves = null, settles = null;
  for (const [x, v] of curves) {
    const finite = v.filter(Number.isFinite); if (finite.length < 2) continue;
    const first = finite[0], last = finite[finite.length - 1], r = Math.max(...finite) - Math.min(...finite); if (!(r > 0)) continue;
    const n = Math.min(x.length, v.length);
    for (let i = 0; i < n; i++) if (x[i] > 0 && Math.abs(v[i] - first) > 0.01 * r) { moves = moves === null ? x[i] : Math.min(moves, x[i]); break; }
    for (let i = n - 1; i >= 0; i--) if (Math.abs(v[i] - last) > 0.01 * r) { settles = settles === null ? x[i] : Math.max(settles, x[i]); break; }
  }
  return {moves, settles};
}
/** How the steps of a transient bench share a time axis, as copper sim's pages draw them. */
export function timeLayout(bench) {
  const all = bench.steps.map((_, k) => k), spans = bench.steps.map(s => span(s.x));
  if (bench.analysis.kind !== 'tran' || bench.steps.length < 2) return {kind: 'shared', groups: [all]};
  const lo = Math.min(...spans), hi = Math.max(...spans);
  if (!(lo > 0) || hi / lo <= 3) return {kind: 'shared', groups: [all]};
  const periods = bench.steps.map(s => num(s.analysis.steady_period_s) ?? num(bench.analysis.steady_period_s));
  if (periods.every(p => p > 0)) return {kind: 'periods', groups: [all], periods};
  const order = [...all].sort((a, b) => spans[a] - spans[b]), groups = [];
  for (const k of order) { const g = groups[groups.length - 1]; if (g && spans[k] <= spans[g[0]] * 3) g.push(k); else groups.push([k]); }
  for (const g of groups) g.sort((a, b) => a - b);
  groups.sort((a, b) => a[0] - b[0]);
  return {kind: 'groups', groups};
}
/** Limit marks of a plot: horizontal lines (`min(P)`, `max(P)`) and windows (`at(P, x)`), grouped by equal limits. */
export function plotMarks(bench, plotIndex, steps) {
  const marks = [];
  for (const m of bench.measures) {
    if (!m.mark || m.mark.plot !== plotIndex) continue;
    const scope = m.where ? ` (where ${m.where})` : '';
    if (m.mark.kind === 'lines') {
      for (const side of ['min', 'max']) {
        const groups = new Map();
        for (const k of steps) { const s = m.steps[k]; if (!s?.covered || s[side] === null) continue; const key = s[side]; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(k); }
        for (const [value, ks] of groups) marks.push({kind: 'line', measure: m.name, side, value, steps: ks, fail: ks.some(k => m.steps[k].pass === false || m.steps[k].never),
          label: `${m.name} ${side} ${formatQuantity(value, m.units, m.dimension)}${ks.length < steps.length ? groups.size === 1 && scope ? scope : ` (${plural(ks.length, 'step')})` : ''}`});
      }
    } else {
      const groups = new Map();
      for (const k of steps) { const s = m.steps[k]; if (!s?.covered || s.at === null || (s.min === null && s.max === null)) continue; const key = `${s.at}|${s.min}|${s.max}`; if (!groups.has(key)) groups.set(key, {at: s.at, min: s.min, max: s.max, points: []}); groups.get(key).points.push({step: k, value: s.value, pass: s.pass}); }
      for (const g of groups.values()) marks.push({kind: 'window', measure: m.name, at: g.at, min: g.min, max: g.max, points: g.points, fail: g.points.some(p => p.pass === false),
        label: `${m.name} at ${formatQuantity(g.at, bench.axis?.units || '', bench.axis?.dimension)}: ${stepLimitText(g, m)}${g.points.length < steps.length ? ` (${plural(g.points.length, 'step')})` : ''}`});
    }
  }
  return marks;
}
/**
 * A loop gain's phase margin drawn where copper sim's pages draw it: at each step's crossover, the phase
 * there (-180 deg plus the margin) against the required phase (-180 deg plus the limit). Only with both a
 * `phase_margin(...)` and a `crossover(...)` measure, and a minimum on the margin.
 */
export function phaseMarginMarks(bench, steps) {
  const pm = bench.measures.find(m => /^phase_margin\(/.test(m.expression)), co = bench.measures.find(m => /^crossover\(/.test(m.expression));
  if (!pm || !co) return [];
  const out = [];
  for (const k of steps) {
    const f = co.steps[k]?.value, s = pm.steps[k];
    if (!(f > 0) || !s || s.value === null || s.min === null || !s.covered) continue;
    out.push({kind: 'window', measure: pm.name, at: f, min: -180 + s.min, max: null, points: [{step: k, value: -180 + s.value, pass: s.pass}], fail: s.pass === false,
      label: out.length ? '' : `${pm.name} at crossover: min ${formatQuantity(s.min, pm.units, pm.dimension)}`});
  }
  return out;
}
/**
 * The figures of a bench's plots: one (or one per time scale) holding a panel per plotted expression on
 * a shared x axis, the magnitude-like panels above the phase-like ones. Each panel says which steps have
 * no values in the document (`missing`), so the view can say so instead of drawing nothing.
 */
export function plotFigures(bench) {
  if (!bench.plots.length || !bench.steps.length || !bench.axis) return [];
  const layout = timeLayout(bench), order = [...bench.plots].sort((a, b) => Number(isPhase(a)) - Number(isPhase(b)) || a.index - b.index);
  const loop = p => /loop_gain\(\)/.test(p.expression);
  return layout.groups.map((steps, g) => {
    const periods = layout.kind === 'periods' ? layout.periods : null;
    const x = periods ? {name: 'time', units: '', dimension: null, scale: 'linear', label: 'periods of each step\'s steady state', periods: true}
      : {name: bench.axis.name, units: bench.axis.units, dimension: bench.axis.dimension, scale: bench.axis.scale, label: bench.axis.name};
    const panels = order.map(p => {
      const series = steps.map(k => ({step: k, x: periods ? bench.steps[k].x.map(t => t / periods[k]) : bench.steps[k].x, time: periods ? bench.steps[k].x : null, y: p.steps[k]}));
      const values = series.flatMap(s => s.y || []).filter(Number.isFinite);
      const positive = values.length > 0 && values.every(v => v > 0);
      const refs = loop(p) ? (isPhase(p) ? [{value: -180, label: '-180 deg'}] : /^db\(/.test(p.expression) ? [{value: 0, label: '0 dB'}] : []) : [];
      return {plot: p.index, expression: p.expression, units: p.units, dimension: p.dimension, phase: isPhase(p), series, missing: series.filter(s => !s.y).map(s => s.step),
        logY: positive && (bench.analysis.kind === 'noise' || isNoiseDensity(p)), canLogY: positive, marks: [...plotMarks(bench, p.index, steps), ...(loop(p) && isPhase(p) ? phaseMarginMarks(bench, steps) : [])], refs};
    });
    let logX = x.scale === 'log';
    if (bench.analysis.kind === 'tran' && !periods) {
      const curves = panels.flatMap(p => p.series.filter(s => s.y).map(s => [s.x, s.y]));
      const {moves, settles} = activity(curves);
      // A start-up: nearly all change in the first tenth, and settling two decades after the first movement.
      if (earlyShare(curves) >= 0.8 && moves > 0 && settles >= moves * 100 && steps.every(k => bench.steps[k].x.some(t => t > 0))) logX = true;
    }
    const title = layout.kind === 'groups' ? `time scale ${g + 1} of ${layout.groups.length}: ${steps.length === 1 ? stepShort(bench, steps[0]) : plural(steps.length, 'step')}` : null;
    return {id: `${bench.index}-${g}`, title, steps, x: {...x, logDefault: logX, canLog: x.scale === 'log' || steps.every(k => bench.steps[k].x.some(t => t > 0))}, panels, layout: layout.kind};
  });
}
/** The plots that the document carries no values for, per step, with where they would be (the bench's CSV). */
export function missingVectors(bench) {
  const out = [];
  for (const p of bench.plots) { const steps = p.steps.map((v, k) => v ? null : k).filter(k => k !== null); if (steps.length) out.push({expression: p.expression, steps}); }
  return out;
}

// ---- Spectra ----------------------------------------------------------------------------------
const SPECTRUM_HARMONICS = 50;
/**
 * A spectrum as levels in dB per step: relative to the fundamental (dBc, x in harmonics of f0) when
 * coherent, else relative to 1 of its unit (x in Hz). The integration floor is the level below which
 * components are inside the solver's integration error; the 0 Hz bin is left out (log axis).
 */
export function spectrumFigure(bench, k) {
  const sp = bench.spectra[k]; if (!sp) return null;
  const notes = [], series = [];
  let floorDb = -Infinity, coherent = sp.coherent;
  for (const [step, s] of sp.steps.entries()) {
    if (!s || !s.frequency_hz) { series.push({step, x: null, y: null}); continue; }
    let reference = 1, scale = 1;
    if (coherent) {
      const f0 = s.fundamental_hz, i = f0 ? s.frequency_hz.findIndex(f => Math.abs(f / f0 - 1) < 1e-6) : -1;
      if (i >= 0 && s.amplitude[i] > 0) { reference = s.amplitude[i]; scale = f0; } else { coherent = false; notes.push(`${stepShort(bench, step)}: no fundamental bin, so levels are relative to 1 ${displayBase(sp.units) || sp.units}.`); }
    }
    const x = [], y = [];
    for (let i = 0; i < s.frequency_hz.length; i++) { if (!(s.frequency_hz[i] > 0)) continue; const h = s.frequency_hz[i] / scale; if (coherent && h > SPECTRUM_HARMONICS) break; x.push(h); y.push(20 * Math.log10(Math.max(s.amplitude[i] / reference, 1e-15))); }
    let peak = 0; for (let i = 0; i < s.amplitude.length; i++) if (s.frequency_hz[i] > 0) peak = Math.max(peak, s.amplitude[i]);
    if (s.integration_floor !== null && s.integration_floor > 0) floorDb = Math.max(floorDb, 20 * Math.log10((coherent ? 1 : Math.max(peak, Number.MIN_VALUE)) * s.integration_floor));
    series.push({step, x, y});
  }
  const missing = series.filter(s => !s.x).map(s => s.step);
  const unit = displayBase(sp.units) || sp.units;
  return {expression: sp.expression, coherent, units: coherent ? 'dBc' : `dB re 1 ${unit}`, steps: sp.steps.map((_, i) => i), series, missing, notes,
    floor: Number.isFinite(floorDb) ? {value: floorDb, label: 'integration floor'} : null,
    x: coherent ? {name: 'harmonic of the fundamental', units: '', scale: 'log', harmonics: true} : {name: 'frequency', units: 'Hz', dimension: 'Frequency', scale: 'log'}};
}
/** One step's spectrum in words: window, periods, samples and the floor. */
export function spectrumStepText(s) {
  if (!s) return 'no spectrum';
  return [s.fundamental_hz ? `f0 ${hertz(s.fundamental_hz)}, ${plural(s.periods, 'period')}` : null, `${s.window.replace(/_/g, '-') || '?'} window`, `${s.samples} samples`,
    s.span_s !== null ? `span ${seconds(s.span_s)} from ${seconds(s.start_s || 0)}` : null, s.integration_floor !== null ? `floor ${significant(20 * Math.log10(s.integration_floor), 3)} dB${s.uniform_steps ? ' (uniform steps)' : ''}` : null].filter(Boolean).join(' · ');
}

// ---- Noise, poles and zeros, variation, rails ---------------------------------------------------
/** The noise entries of a step: per output, total and the contributors with their share, largest first. */
export function noiseAt(bench, step) { return bench.noise.filter(n => n.step === step).map(n => ({...n, contributors: [...n.contributors].sort((a, b) => (b.share ?? 0) - (a.share ?? 0))})); }
/** Contributors grouped by owner (all generators of one part summed in power). */
export function noiseByOwner(entry) {
  const owners = new Map();
  for (const c of entry.contributors) { const o = c.owner || c.contributor; const g = owners.get(o) || {owner: o, share: 0, power: 0, parts: []}; g.share += c.share ?? 0; g.power += (c.rms_v ?? 0) ** 2; g.parts.push(c.contributor); owners.set(o, g); }
  return [...owners.values()].map(g => ({...g, rms_v: Math.sqrt(g.power)})).sort((a, b) => b.share - a.share);
}
/** Histogram of a Monte Carlo measure's runs, each bin marked when it lies outside the step's limits. */
export function histogram(values, {min = null, max = null, bins = null} = {}) {
  const v = values.filter(Number.isFinite); if (!v.length) return null;
  let lo = Math.min(...v), hi = Math.max(...v);
  if (lo === hi) { const d = Math.abs(lo) * 1e-6 || 1e-12; lo -= d; hi += d; }
  const count = bins || Math.min(40, Math.max(6, Math.ceil(Math.sqrt(v.length))));
  const width = (hi - lo) / count, out = Array.from({length: count}, (_, i) => ({lo: lo + i * width, hi: lo + (i + 1) * width, count: 0}));
  for (const x of v) out[Math.min(count - 1, Math.floor((x - lo) / width))].count++;
  for (const b of out) b.outside = (min !== null && b.hi <= min) || (max !== null && b.lo >= max);
  return {bins: out, lo, hi, n: v.length, peak: Math.max(...out.map(b => b.count))};
}
/** A step's variation of one measure, with that step's limits from the measure. */
export function variationRows(bench, step) {
  const v = bench.variation; if (!v) return [];
  const s = v.steps.find(x => x.index === step) || v.steps[step]; if (!s) return [];
  return s.measures.map(m => { const measure = bench.measures.find(x => x.name === m.name) || {name: m.name, units: '1', dimension: null, steps: []}; const lim = measure.steps[step] || {min: null, max: null}; return {...m, measure, limit: {min: lim.min, max: lim.max}, runs: s.runs, step_yield: s.yield}; });
}
/** The supplies of a step, following `bias_step` to the step whose bias point it shares. */
export function railsAt(bench, step) {
  const s = bench.steps[step]; if (!s) return {supplies: null, stress: null, pins: null, from: null};
  const source = s.bias_step !== null && bench.steps[s.bias_step] ? bench.steps[s.bias_step] : s;
  return {supplies: source.supplies, stress: source.stress, pins: source.pins, from: source === s ? null : s.bias_step};
}
/** Notes on a bench the reader should see: errors, steady-state fallbacks, missing vectors, ignored parts. */
function benchNotes(b) {
  const notes = [];
  if (b.error) notes.push({level: 'error', text: `Not solved: ${b.error}`});
  for (const s of b.steps) if (s.transient?.steady_fallback) notes.push({level: 'warning', text: `${b.steps.length > 1 ? `${s.label}: ` : ''}the periodic steady state was not found by shooting (${s.transient.steady_fallback}); the run settled period by period instead.`});
  const missing = missingVectors(b);
  if (missing.length && b.steps.length) notes.push({level: 'warning', text: `${missing.map(m => m.expression).join(', ')}: no values in sim-results.json for ${missing[0].steps.length === b.steps.length ? 'any step' : `steps ${missing[0].steps.map(k => k + 1).join(', ')}`}.${b.files.csv ? ` The CLI wrote them to ${b.files.csv}; open that CSV (Open → File…, or drop it) to draw them.` : ' The bench names no CSV either.'}`, csv: b.files.csv});
  if (b.spectra.some(sp => sp.steps.some(s => !s?.frequency_hz))) notes.push({level: 'warning', text: `A spectrum has no bins in sim-results.json for some steps.${b.files.spectrum_csv ? ` Open ${b.files.spectrum_csv} to draw it.` : ''}`, csv: b.files.spectrum_csv});
  const names = n => n.length > 8 ? `${n.slice(0, 8).join(', ')} and ${n.length - 8} more` : n.join(', ');
  const ignored = b.models.filter(m => m.fidelity === 'ignored').map(m => m.name);
  if (ignored.length) notes.push({level: 'info', text: `Left out of this analysis: ${names(ignored)}.`});
  const replaced = b.models.filter(m => m.fidelity === 'replaced').map(m => m.name);
  if (replaced.length) notes.push({level: 'info', text: `Replaced by a bench model: ${names(replaced)}.`});
  if (b.analysis.kind === 'tran' && num(b.analysis.noise_seed) !== null) notes.push({level: 'info', text: `Transient noise is on (seed ${b.analysis.noise_seed}): waveforms carry random noise.`});
  return notes;
}
/** `Components: 7 ideal, 2 macro, 1 vendor`, counted per fidelity. */
export function fidelityLine(bench) {
  const counts = new Map(); for (const m of bench.models.filter(m => m.kind === 'component')) counts.set(m.fidelity, (counts.get(m.fidelity) || 0) + 1);
  return counts.size ? `Components: ${[...counts].map(([f, c]) => `${c} ${f}`).join(', ')}` : 'No components listed';
}
/** Models grouped by fidelity and model text, as the bench page lists them. */
export function modelGroups(bench) {
  const groups = [];
  for (const m of bench.models) {
    const name = `${m.kind === 'supply' ? `supply ${m.name}` : m.name}${m.bench ? ' (bench)' : ''}`, what = m.fidelity === 'ignored' ? '' : m.model;
    const g = groups.find(x => x.fidelity === m.fidelity && x.model === what);
    if (g) { g.names.push(name); for (const p of m.inactive) if (!g.inactive.includes(p)) g.inactive.push(p); } else groups.push({fidelity: m.fidelity, model: what, names: [name], inactive: [...m.inactive]});
  }
  return groups;
}

// ---- The side CSVs: vectors the JSON lacks -------------------------------------------------------
/** Split one CSV line (RFC 4180 quotes). */
function csvFields(line) {
  const out = []; let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') quoted = false; else cur += c; }
    else if (c === '"') quoted = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur); return out;
}
const csvNumber = t => t === '' ? NaN : Number(t);
const stripUnit = h => h.replace(/\s*\[[^\]]*\]\s*$/, '');
/**
 * Fill a bench's missing vectors from the CSV copper sim wrote beside the results (`NAME.csv`:
 * step,label,<axis>,<plot> [unit],...; or `NAME.spectrum.csv`). Only vectors the JSON lacks are filled;
 * vectors it carries are kept. Returns {bench, filled, plots} or throws a clear Error.
 */
export function mergeCsv(model, fileName, text) {
  const lines = text.split(/\r?\n/).filter(l => l.length);
  if (!lines.length) throw Error(`${fileName} is empty.`);
  const head = csvFields(lines[0]);
  const bench = model.benches.find(b => b.files.csv === fileName || b.files.spectrum_csv === fileName);
  if (!bench) throw Error(`${fileName} is not a CSV of a bench in the open results (each bench names its CSV in files.csv).`);
  const rows = lines.slice(1).map(csvFields);
  if (head[0] !== 'step' || head[1] !== 'label') throw Error(`${fileName} does not start with the step,label columns copper sim writes.`);
  let filled = 0;
  if (bench.files.spectrum_csv === fileName) {
    if (head.join(',') !== 'step,label,spectrum,frequency_hz,harmonic,amplitude,level_db') throw Error(`${fileName} does not have the columns of a copper sim spectrum CSV.`);
    for (const sp of bench.spectra) for (const [k, s] of sp.steps.entries()) {
      if (s?.frequency_hz) continue;
      const mine = rows.filter(r => Number(r[0]) === k && stripUnit(r[2]) === sp.expression);
      if (!mine.length) continue;
      const f = mine.map(r => csvNumber(r[3])), a = mine.map(r => csvNumber(r[5]));
      sp.steps[k] = {...(s || {fundamental_hz: null, periods: 0, window: '', samples: 0, start_s: null, span_s: null, uniform_steps: false, integration_floor: null}), frequency_hz: f, amplitude: a}; filled++;
    }
  } else {
    const columns = head.slice(3).map(stripUnit);
    for (const p of bench.plots) {
      const c = columns.indexOf(p.expression); if (c < 0) continue;
      for (const [k, v] of p.steps.entries()) {
        if (v) continue;
        const mine = rows.filter(r => Number(r[0]) === k); if (!mine.length) continue;
        const x = mine.map(r => csvNumber(r[2])), y = mine.map(r => csvNumber(r[3 + c]));
        if (!bench.steps[k].x.length) bench.steps[k].x = x;
        if (bench.steps[k].x.length !== y.length) throw Error(`${fileName}: step ${k} has ${y.length} rows but the results have ${bench.steps[k].x.length} axis values; the CSV is from another run.`);
        p.steps[k] = y; filled++;
      }
    }
  }
  bench.notes = benchNotes(bench);
  return {bench, filled};
}
