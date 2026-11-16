/* EMI screening results from a CopperScript run report (`route-report.json`, key `emi`).
 * Pure data and geometry, no DOM, so Node's built-in tests exercise it. Everything here is a
 * screening estimate: it ranks likely noise sources and is never a pass/fail or compliance result. */
import {padCorners,distanceToSegment} from './core.js';
export const ROUTE_REPORT_PREFIX = 'copperscript-route-board/';
export const EMI_SECTION_PREFIX = 'copperscript-emi-check/';
export const EMI_SCREENING_LINE = 'Screening estimate, not a compliance measurement. It ranks likely noise sources; it is not a pass or fail.';
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const num = v => typeof v === 'number' && Number.isFinite(v) ? v : null;
const list = v => Array.isArray(v) ? v : [];
const strings = v => list(v).filter(s => typeof s === 'string');
const round2 = v => Math.round(v * 100) / 100;
/** Fixed point with at most two decimals and no trailing zeros, as CopperScript's own pictures print numbers. */
export const n = v => { const t = (Math.round(v * 100) / 100).toFixed(2).replace(/\.?0+$/, ''); return t === '-0' ? '0' : t; };
export const frequencyText = hz => hz >= 1e6 ? `${n(hz / 1e6)} MHz` : `${n(hz / 1e3)} kHz`;
/** "12.3 dB over the average limit" / "4.1 dB under the quasi-peak limit"; `margin` is limit minus level. */
export function marginPhrase(margin, limit) {
  if (Math.abs(margin) < 0.05) return `at the ${limit} limit`;
  return margin < 0 ? `${n(-margin)} dB over the ${limit} limit` : `${n(margin)} dB under the ${limit} limit`;
}
/** Plain sentences for the assumption tags, most consequential first (ported from CopperScript's emi_plot.rs). */
export const ASSUMPTIONS = [
  ['worst_case_current', 'The current is the switch current limit, a worst case, not a load current.'],
  ['scenario_current_limit', 'The current is the switch current limit, a worst case, not a load current.'],
  ['declared_operating_point', 'The current is the declared operating point.'],
  ['scenario_declared_operating_point', 'The current is the declared operating point.'],
  ['operating_point_outside_model', 'The declared operating point lies outside what the model covers.'],
  ['detector_not_applicable', 'The levels are line amplitudes, not detector readings.'],
  ['line_amplitudes_only', 'The levels are line amplitudes, not detector readings.'],
  ['detector_receiver_emulation', 'Detector readings come from a receiver emulation at some harmonics only.'],
  ['line_amplitudes_outside_the_evaluated_harmonics', 'The other harmonics are line amplitudes only.'],
  ['differential_mode_only', 'Differential mode only; common mode is not modelled.'],
  ['frequency_range_bound', 'One fixed frequency of a declared range; swept operation is not modelled.'],
  ['rule_of_thumb_edge', 'Switching edge times come from a rule of thumb, not a datasheet.'],
  ['edge_from_slew_rate', 'Edge times are derived from the declared slew rate.'],
  ['current_edge_from_voltage_edge', 'The current edge is taken equal to the voltage edge.'],
  ['rule_of_thumb_ripple', 'The inductor ripple comes from a rule of thumb.'],
  ['rule_of_thumb_dc_bias', 'Capacitor DC-bias derating comes from a rule of thumb.'],
  ['rule_of_thumb_capacitance', 'Capacitance derating comes from a rule of thumb.'],
  ['default_capacitor_parasitics', 'Capacitor ESR and ESL are defaults, not datasheet values.'],
  ['estimated_connection_inductance', 'Connection inductance is estimated from the placement.'],
  ['extracted_connection_inductance', 'Connection inductance is extracted from the routed copper.'],
  ['extraction_indicative', 'The inductance extraction is indicative only.'],
  ['anti_resonance_in_band', 'An anti-resonance of the input filter falls inside the band.'],
  ['capacitor_branch_skipped', 'A capacitor branch is left out of the model.'],
  ['filter_inductor_ideal', 'The filter inductor is modelled as ideal.'],
  ['feed_resistance_not_modelled', 'The source resistance is not modelled.'],
];
/** The sentences of `tags`, each once; a tag the table does not know is shown as its own words. */
export function assumptionSentences(tags) {
  const rank = t => { const i = ASSUMPTIONS.findIndex(([k]) => k === t); return i < 0 ? ASSUMPTIONS.length : i; };
  const out = [];
  for (const tag of strings(tags).map((t, i) => [t, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(x => x[0])) {
    const known = ASSUMPTIONS.find(([k]) => k === tag);
    const words = tag.replace(/_/g, ' ').trim();
    const sentence = known ? known[1] : words ? `${words[0].toUpperCase()}${words.slice(1)}.` : '';
    if (sentence && !out.includes(sentence)) out.push(sentence);
  }
  return out;
}
/** What kind of file a parsed JSON value is: a run report, a bare emi section, or neither. */
export function emiDocumentKind(value) {
  const schema = isObject(value) ? value.schema : null;
  if (typeof schema !== 'string') return null;
  if (schema.startsWith(ROUTE_REPORT_PREFIX)) return 'route-report';
  if (schema.startsWith(EMI_SECTION_PREFIX)) return 'emi-section';
  return null;
}
const MISSING = 'This run report has no `emi` section. Write one with `copper emi-check BOARD --run RUN --write` (or route again with route-board, which stores it).';
/** A bare "FB" may be a net or a component; the scene decides. */
const padOf = (scene, ref, number) => scene.components.find(c => c.reference === ref)?.pads.find(p => p.number === number) || null;
const refOf = (text) => { const m = /(?:^|\s)([^\s]+)\.([^\s.]+)$/.exec(String(text)); return m ? {component: m[1], number: m[2]} : null; };
const boundsOf = points => points.length ? [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])), Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))] : null;
const joinBounds = boxes => { const b = boxes.filter(Boolean); return b.length ? [Math.min(...b.map(x => x[0])), Math.min(...b.map(x => x[1])), Math.max(...b.map(x => x[2])), Math.max(...b.map(x => x[3]))] : null; };
/**
 * Read the `emi` section of a parsed route-report.json (or a bare emi section). Never throws on content:
 * a missing, errored or older-schema section gives an empty or partial model and `notes` saying why.
 * `scene` (optional) lets the reader check that the board matches the report.
 */
export function readEmi(value, scene = null, {name = null, sha256 = null} = {}) {
  const kind = emiDocumentKind(value);
  const notes = [];
  const section = kind === 'emi-section' ? value : isObject(value?.emi) ? value.emi : null;
  const model = {
    source: {kind, file: name, report_schema: typeof value?.schema === 'string' ? value.schema : null,
      emi_schema: typeof section?.schema === 'string' ? section.schema : null, board_name: typeof section?.board === 'string' ? section.board : null,
      evidence_grade: typeof section?.evidence_grade === 'string' ? section.evidence_grade : 'screening', report_sha256: sha256, board_verified: false},
    limits: isObject(section?.limits) ? section.limits : {}, cells: [], findings: [], notes, coverage: list(section?.coverage).filter(isObject), summary: isObject(section?.summary) ? section.summary : null,
  };
  if (!section) { notes.push(MISSING); return model; }
  if (typeof section.error === 'string') notes.push(`The report records an EMI analysis error: ${section.error}`);
  model.cells = list(section.cells).filter(isObject);
  const raw = list(section.findings).filter(f => isObject(f) && typeof f.code === 'string');
  model.findings = raw.map((f, i) => ({
    id: `E${i + 1}`, index: i, cell: typeof f.cell === 'string' ? f.cell : '', code: f.code, severity: typeof f.severity === 'string' ? f.severity : 'info',
    message: typeof f.message === 'string' ? f.message : '', nets: strings(f.nets), objects: strings(f.objects), layers: strings(f.layers), tags: strings(f.tags),
    margin_db: num(f.margin_db), estimate: isObject(f.estimate) ? f.estimate : null, measures: isObject(f.measures) ? f.measures : {},
    accepted: f.accepted ? (typeof f.accepted === 'string' ? f.accepted : isObject(f.accepted) && typeof f.accepted.reason === 'string' ? f.accepted.reason : 'accepted') : null,
    measured_nm: num(f.measured_nm), required_nm: num(f.required_nm),
  }));
  if (!model.findings.length && !section.error) notes.push('The EMI section has no findings (the design has no switching cell, or nothing was flagged).');
  if (kind === 'route-report' && typeof section.schema === 'string' && !section.schema.startsWith(EMI_SECTION_PREFIX)) notes.push(`The EMI section has schema ${section.schema}, not ${EMI_SECTION_PREFIX}…; fields are read as far as they match.`);
  const hot = model.findings.filter(f => f.code === 'EMI-HOT-LOOP');
  if (hot.some(f => !Array.isArray(f.measures.loop_path_3d_mm))) notes.push(`${hot.every(f => !Array.isArray(f.measures.loop_path_3d_mm)) ? 'No hot loop in this report has a' : 'Some hot loops in this report have no'} traced path (\`loop_path_3d_mm\`; an older report): drawn from the pad-centre outline instead. Rerun \`copper emi-check BOARD --run RUN --write\` for the traced loop.`);
  if (model.findings.some(f => f.code === 'EMI-CONDUCTED' && !isObject(f.measures.worst_harmonic) && !list(f.measures.harmonics).length)) notes.push('A conducted finding lists no harmonics (older report): no spectrum can be drawn for it.');
  if (scene) {
    const have = new Set(scene.components.flatMap(c => [c.reference, c.source_path, c.native_reference].filter(Boolean)));
    const nets = new Set(scene.nets.map(x => x.name));
    const refs = new Set([...model.cells.flatMap(c => [c.controller, c.magnetic, c.catch_diode, ...strings(c.hot_capacitors)]), ...model.findings.flatMap(f => [f.cell, ...f.objects.filter(o => !nets.has(o))])].filter(x => typeof x === 'string' && x));
    const missing = [...refs].filter(r => !have.has(r));
    if (missing.length) notes.push(`${missing.length} part${missing.length === 1 ? '' : 's'} named in the report (${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}) are not on this board: it may not be the board this report describes. The report carries no board hash, so nothing was verified.`);
    else notes.push('Report and board agree on part references. The report carries no board hash, so this is not proof they match.');
  }
  return model;
}
/** Cells with their findings, in report order; findings of a cell the report does not describe still get a group. */
export function groupByCell(model) {
  const groups = new Map();
  for (const c of model.cells) groups.set(c.controller, {name: c.controller, cell: c, findings: []});
  for (const f of model.findings) { if (!groups.has(f.cell)) groups.set(f.cell, {name: f.cell, cell: null, findings: []}); groups.get(f.cell).findings.push(f); }
  return [...groups.values()];
}
export const findingById = (model, id) => model?.findings.find(f => f.id === id) || null;
const CODE_TEXT = {'EMI-HOT-LOOP': 'Hot loop', 'EMI-CONDUCTED': 'Conducted emission', 'EMI-SWITCH-NODE': 'Switch node', 'EMI-PROXIMITY': 'Proximity', 'EMI-FIELD': 'Field', 'EMI-RETURN-PATH': 'Return path', 'EMI-DECOUPLING-PATH': 'Decoupling path'};
export const codeText = code => CODE_TEXT[code] || code.replace(/^EMI-/, '').toLowerCase().replace(/-/g, ' ').replace(/^./, c => c.toUpperCase());
const limitName = model => model.limits.standard ? String(model.limits.standard) : null;
const worstOf = f => isObject(f.measures.worst_harmonic) ? f.measures.worst_harmonic : null;
/** Key numbers of a finding as [label, text] rows for the panel. Missing fields are simply left out. */
export function findingFacts(f, model) {
  const m = f.measures, rows = [], add = (label, text) => { if (text !== null && text !== undefined && text !== '') rows.push([label, text]); };
  const e = f.estimate;
  if (f.code === 'EMI-HOT-LOOP') {
    if (num(m.loop_inductance_nh) !== null) add('Hot-loop inductance', `${n(m.loop_inductance_nh)} nH`);
    if (num(m.loop_area_mm2) !== null) add('Loop area', `${n(m.loop_area_mm2)} mm²`);
    const length = num(m.traced_path_length_mm) ?? num(m.path_length_mm);
    if (length !== null) add('Loop path', `${n(length)} mm${num(m.trace_via_count) ? `, ${m.trace_via_count} via${m.trace_via_count === 1 ? '' : 's'}` : ''}`);
    if (e && num(e.value) !== null && e.unit === 'dBuV/m') {
      const where = `${n(e.value)} dBuV/m${num(e.frequency_hz) ? ` at ${frequencyText(e.frequency_hz)}` : ''}${num(model.limits.distance_m) ? `, ${n(model.limits.distance_m)} m` : ''}`;
      add('Radiated field, worst point', where);
      if (f.margin_db !== null) add('Margin', `${marginPhrase(f.margin_db, 'radiated')}${limitName(model) ? ` (${limitName(model)} line)` : ''}`);
    }
    if (num(m.ring_frequency_mhz) !== null) add('Ringing', `about ${n(m.ring_frequency_mhz)} MHz${num(m.ring_overshoot_v) !== null ? `, overshoot up to ${n(m.ring_overshoot_v)} V` : ''}`);
    if (isObject(m.loop_current) && m.loop_current.scenario) add('Current', `${String(m.loop_current.scenario).replace(/_/g, ' ')}${num(m.loop_current.field_amplitude_a) !== null ? `, ${n(m.loop_current.field_amplitude_a)} A` : ''}`);
    if (typeof m.trace_status === 'string') add('Loop geometry', m.trace_status.replace(/_/g, ' '));
  } else if (f.code === 'EMI-CONDUCTED') {
    const spec = spectrumModel(f, model), w = spec && spec.worstIndex !== null ? spec.harmonics[spec.worstIndex] : null;
    if (w) {
      add(spec.showLimits ? 'Worst harmonic' : 'Highest line amplitude', `${w.harmonic ? `#${w.harmonic} ` : ''}${frequencyText(w.frequency_hz)}: ${n(w.level)} dBuV`);
      if (spec.showLimits) {
        if (w.limit_avg !== null) add('Against the average limit', marginPhrase(w.limit_avg - w.level, 'average'));
        if (w.limit_qp !== null) add('Against the quasi-peak limit', marginPhrase(w.limit_qp - w.level, 'quasi-peak'));
      } else add('Limits', `not drawn: ${spec.detectorReason}`);
      if (w.low !== null && w.high !== null && w.high - w.low > 0.05) add('Band over the rule-of-thumb inputs', `${n(w.low)} to ${n(w.high)} dBuV`);
    }
    if (num(m.harmonics_over_quasi_peak) !== null && spec?.showLimits) add('Harmonics over the limits', `${m.harmonics_over_quasi_peak} of ${m.harmonics_reported ?? '?'} over quasi-peak, ${m.harmonics_over_average ?? '?'} over average (high ends)`);
    const ar = antiResonances(f);
    add('Anti-resonances', ar.length ? `${ar.length} between 150 kHz and 30 MHz${ar.some(a => a.significant) ? `, ${ar.filter(a => a.significant).length} significant` : ', none significant'}` : Array.isArray(m.anti_resonances) ? 'none between 150 kHz and 30 MHz' : null);
    if (num(m.hot_loop_inductance_nh) !== null) add('Hot-loop inductance used', `${n(m.hot_loop_inductance_nh)} nH`);
    if (m.scenario) add('Current', String(m.scenario).replace(/_/g, ' '));
  } else if (f.code === 'EMI-SWITCH-NODE') {
    if (num(m.copper_area_mm2) !== null) add('Switch-node copper', `${n(m.copper_area_mm2)} mm²${num(m.pad_area_mm2) !== null ? ` (pads ${n(m.pad_area_mm2)} mm²)` : ''}`);
    if (num(m.capacitance_to_plane_pf) !== null) add('Capacitance to the plane', `${n(m.capacitance_to_plane_pf)} pF`);
    if (e && num(e.value) !== null) add('Coupling-risk score', `${n(e.value)} dB, ranking only (no field, no margin)`);
    if (num(m.distance_to_board_edge_mm) !== null) add('Distance to the board edge', `${n(m.distance_to_board_edge_mm)} mm`);
    for (const c of list(m.distance_to_cable_connectors_mm)) if (isObject(c) && num(c.distance_mm) !== null) add(`Distance to ${c.connector}`, `${n(c.distance_mm)} mm`);
  } else if (f.code === 'EMI-PROXIMITY') {
    if (num(m.distance_mm) !== null) add('Distance', `${n(m.distance_mm)} mm${num(m.threshold_mm) !== null ? `, screening distance ${n(m.threshold_mm)} mm` : ''}`);
    if (m.source) add('Source', `${m.source}${m.source_kind ? ` (${String(m.source_kind).replace(/_/g, ' ')}${m.source_shielding && m.source_shielding !== 'n/a' ? `, ${m.source_shielding}` : ''})` : ''}`);
    if (m.victim) add('Victim', `${m.victim}${m.victim_kind ? ` (${String(m.victim_kind).replace(/_/g, ' ')})` : ''}`);
  } else if (e && num(e.value) !== null) add('Estimate', `${n(e.value)}${e.unit ? ` ${e.unit}` : ''}${e.kind === 'ranking_score' ? ', ranking only' : ''}`);
  if (f.accepted) add('Accepted', f.accepted);
  if (e && Array.isArray(e.band_db) && e.band_db.length === 2 && f.code !== 'EMI-CONDUCTED') add('Band over the rule-of-thumb inputs', `${n(e.band_db[0])} to ${n(e.band_db[1])} ${e.unit || ''}`);
  return rows;
}
/** Anti-resonances of the input network, as listed by an EMI-CONDUCTED finding. */
export function antiResonances(f) {
  return list(f.measures.anti_resonances).filter(isObject).map(a => ({frequency_hz: num(a.frequency_hz), impedance_ohm: num(a.impedance_ohm) ?? num(a.magnitude_ohm), rise_db: num(a.rise_over_envelope_db), harmonic: num(a.harmonic), harmonic_rise_db: num(a.harmonic_rise_db), significant: !!a.significant, text: typeof a.text === 'string' ? a.text : ''}));
}
/** Capacitor branches of an EMI-CONDUCTED finding with their current share at the worst harmonic. */
export function capacitorBranches(f) {
  return list(f.measures.capacitor_branches).filter(isObject).map(b => ({component: String(b.component ?? '?'), role: typeof b.role === 'string' ? b.role : '', c_uf: num(b.capacitance_used_uf), esr_mohm: num(b.esr_mohm), esl_nh: num(b.esl_nh), share: num(b.current_share_worst_harmonic), defaulted: strings(b.defaulted)}));
}
/** Named mechanisms the model leaves out (collapsed in the panel). */
export const notModelled = f => [...new Set([...strings(f.estimate?.not_modelled), ...strings(f.measures.not_modelled), ...strings(f.measures.missing_for_absolute_prediction)])];
/** Each finding's own long assumption sentences (the solver's, not the tags), for the collapsed details. */
export const assumptionDetails = f => strings(f.measures.assumptions);

// ---- Spectrum ---------------------------------------------------------------------------------
export const BAND_HZ = [150e3, 30e6];
const CONDUCTED = {
  B: {qp: [[150e3, 66], [500e3, 56], [500e3, 56], [5e6, 56], [5e6, 60], [30e6, 60]], avg: [[150e3, 56], [500e3, 46], [500e3, 46], [5e6, 46], [5e6, 50], [30e6, 50]]},
  A: {qp: [[150e3, 79], [500e3, 79], [500e3, 73], [30e6, 73]], avg: [[150e3, 66], [500e3, 66], [500e3, 60], [30e6, 60]]},
};
/** The CISPR 32 mains-port conducted limit lines (table transcribed by CopperScript, unverified there too). */
export const conductedLimitLines = cls => { const t = CONDUCTED[cls === 'A' ? 'A' : 'B']; return {qp: t.qp.map(p => [...p]), avg: t.avg.map(p => [...p])}; };
/**
 * The conducted spectrum of an EMI-CONDUCTED finding as plain data, or null without harmonics.
 * Mirrors CopperScript's emi_plot.rs: limit lines only when the levels are detector readings.
 */
export function spectrumModel(f, model) {
  if (f.code !== 'EMI-CONDUCTED') return null;
  const m = f.measures;
  const harmonics = list(m.harmonics).filter(isObject).map(h => {
    const total = num(h.total_dbuv), f0 = num(h.frequency_hz);
    if (total === null || f0 === null) return null;
    const high = num(h.high_dbuv), low = num(h.low_dbuv);
    return {frequency_hz: f0, harmonic: num(h.harmonic), total, low, high, level: high ?? total, limit_qp: num(h.limit_qp), limit_avg: num(h.limit_avg), margin_db: num(h.margin_db), reading_qp: isObject(h.receiver) ? num(h.receiver.quasi_peak_high_dbuv) : null};
  }).filter(Boolean).sort((a, b) => a.frequency_hz - b.frequency_hz);
  if (!harmonics.length) return null;
  const status = typeof m.detector_applicability === 'string' ? m.detector_applicability : null;
  const detectorReason = status === 'isolated_lines' ? null : (typeof m.detector_reason === 'string' ? m.detector_reason : 'the report does not state that the isolated-line detector assumption holds');
  const emulated = status === 'receiver_emulation';
  const standard = typeof m.limit_standard === 'string' ? m.limit_standard : null;
  const cls = m.limit_class === 'A' ? 'A' : m.limit_class ? 'B' : standard && /class_a/.test(standard) ? 'A' : 'B';
  const showLimits = detectorReason === null || emulated;
  const drawLimits = showLimits && (standard !== null || harmonics.some(h => h.limit_qp !== null));
  const lines = drawLimits ? conductedLimitLines(cls) : {qp: [], avg: []};
  const cell = model.cells.find(c => c.controller === f.cell);
  const marginIdx = showLimits ? harmonics.map((h, i) => [i, h.margin_db]).filter(x => x[1] !== null).sort((a, b) => a[1] - b[1] || a[0] - b[0]) : [];
  let worstIndex = marginIdx.length ? marginIdx[0][0] : null;
  if (worstIndex === null) harmonics.forEach((h, i) => { if (worstIndex === null || h.level > harmonics[worstIndex].level) worstIndex = i; });
  return {cell: f.cell, frequency_hz: num(cell?.frequency_hz) ?? num(m.switching_frequency_hz), standard, limitClass: cls, tags: f.tags, detectorReason, receiverEmulation: emulated, showLimits, drawLimits, lines, harmonics, worstIndex,
    scenario: typeof m.frequency_scenario === 'string' && m.frequency_scenario !== 'fixed' ? m.frequency_scenario.split(' (')[0] : null};
}
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** The spectrum as an SVG string (classes only; colours live in style.css so dark mode follows the page). */
export function spectrumSvg(spec) {
  const W = 520, LEFT = 44, RIGHT = 10, TOP = 8, PH = 230, plotW = W - LEFT - RIGHT;
  const lf = [Math.log10(BAND_HZ[0]), Math.log10(BAND_HZ[1])];
  const px = f => LEFT + (Math.log10(f) - lf[0]) / (lf[1] - lf[0]) * plotW;
  const vals = [];
  for (const h of spec.harmonics) { vals.push(h.level); if (h.low !== null) vals.push(h.low); if (spec.drawLimits) { if (h.limit_qp !== null) vals.push(h.limit_qp); if (h.limit_avg !== null) vals.push(h.limit_avg); } }
  for (const p of [...spec.lines.qp, ...spec.lines.avg]) vals.push(p[1]);
  const hi = Math.ceil((Math.max(...vals) + 5) / 10) * 10;
  const lo = Math.min(Math.max(Math.floor(Math.min(...vals) / 10) * 10, hi - 90), hi - 30);
  const py = v => TOP + PH - (v - lo) / (hi - lo) * PH;
  const out = [];
  const overAvg = h => spec.showLimits && h.limit_avg !== null && h.level > h.limit_avg;
  const legendRows = 1 + (spec.lines.qp.length ? 1 : 0) + (spec.lines.avg.length ? 1 : 0) + (spec.harmonics.some(h => h.low !== null && h.high !== null && h.high - h.low > 0.05) ? 1 : 0) + (spec.harmonics.some(h => spec.showLimits && h.limit_avg !== null && h.level > h.limit_avg) ? 1 : 0);
  out.push(`<svg class="emi-spectrum" viewBox="0 0 ${W} ${TOP + PH + 66 + 15 * legendRows}" role="img" aria-label="${esc(`${spec.cell} conducted emission spectrum, screening estimate`)}"><title>${esc(spec.cell)} conducted emission spectrum (screening estimate)</title>`);
  out.push(`<defs><clipPath id="emi-clip"><rect x="${LEFT}" y="${TOP}" width="${plotW}" height="${PH}"/></clipPath></defs>`);
  for (let v = lo; v <= hi + 1e-9; v += 10) out.push(`<line class="emi-grid" x1="${LEFT}" y1="${n(py(v))}" x2="${LEFT + plotW}" y2="${n(py(v))}"/><text class="emi-tick" x="${LEFT - 6}" y="${n(py(v) + 4)}" text-anchor="end">${n(v)}</text>`);
  const gridF = [BAND_HZ[0], BAND_HZ[1]];
  for (const d of [1e5, 1e6, 1e7]) for (const k of [1, 2, 5]) { const f = d * k; if (f > BAND_HZ[0] && f < BAND_HZ[1]) gridF.push(f); }
  for (const f of gridF.sort((a, b) => a - b)) {
    out.push(`<line class="emi-grid${[1e5, 1e6, 1e7].includes(f) ? ' major' : ''}" x1="${n(px(f))}" y1="${TOP}" x2="${n(px(f))}" y2="${TOP + PH}"/>`);
    if (f !== 2e5) out.push(`<text class="emi-tick" x="${n(px(f))}" y="${TOP + PH + 15}" text-anchor="middle">${frequencyText(f)}</text>`);
  }
  out.push(`<rect class="emi-frame" x="${LEFT}" y="${TOP}" width="${plotW}" height="${PH}"/>`);
  out.push(`<text class="emi-axis-label" x="${LEFT + plotW / 2}" y="${TOP + PH + 32}" text-anchor="middle">frequency (log scale)</text><text class="emi-axis-label" transform="translate(12,${TOP + PH / 2}) rotate(-90)" text-anchor="middle">level, dBuV</text>`);
  out.push('<g clip-path="url(#emi-clip)">');
  for (const [cls, pts] of [['qp', spec.lines.qp], ['avg', spec.lines.avg]]) if (pts.length >= 2) out.push(`<polyline class="emi-limit ${cls}" points="${pts.map(p => `${n(px(p[0]))},${n(py(p[1]))}`).join(' ')}"/>`);
  const runs = [[]];
  for (const h of spec.harmonics) { if (h.level < lo) { if (runs[runs.length - 1].length) runs.push([]); } else runs[runs.length - 1].push(`${n(px(h.frequency_hz))},${n(py(h.level))}`); }
  for (const h of spec.harmonics) if (h.low !== null && h.high !== null && h.high - h.low > 0.05) out.push(`<g class="emi-band"><rect x="${n(px(h.frequency_hz) - 3.5)}" y="${n(py(h.high))}" width="7" height="${n(py(h.low) - py(h.high))}"/></g>`);
  for (const r of runs.filter(r => r.length >= 2)) out.push(`<polyline class="emi-envelope" points="${r.join(' ')}"/>`);
  const radius = spec.harmonics.length > 20 ? 2.2 : 3;
  spec.harmonics.forEach((h, i) => {
    const over = overAvg(h), x = px(h.frequency_hz), y = py(h.level);
    out.push(`<g class="emi-harmonic${over ? ' over' : ''}" data-frequency-hz="${h.frequency_hz}" data-dbuv="${h.level}">${i < 10 ? `<line x1="${n(x)}" y1="${n(py(lo))}" x2="${n(x)}" y2="${n(y)}"/>` : ''}<circle cx="${n(x)}" cy="${n(y)}" r="${radius}"><title>${esc(`${h.harmonic ? `#${h.harmonic} ` : ''}${frequencyText(h.frequency_hz)}: ${n(h.level)} dBuV${h.limit_avg !== null && spec.showLimits ? `, ${marginPhrase(h.limit_avg - h.level, 'average')}` : ''}`)}</title></circle></g>`);
  });
  out.push('</g>');
  const below = spec.harmonics.filter(h => h.level < lo).length;
  if (below) out.push(`<text class="emi-tick" x="${LEFT}" y="${TOP + PH + 46}">${below} harmonic${below === 1 ? '' : 's'} below ${n(lo)} dBuV not shown</text>`);
  if (spec.worstIndex !== null) {
    const h = spec.harmonics[spec.worstIndex], x = px(h.frequency_hz), y = py(h.level), lines = [];
    if (spec.showLimits) {
      lines.push(`worst harmonic: ${frequencyText(h.frequency_hz)} at ${n(h.level)} dBuV`);
      if (h.limit_avg !== null) lines.push(marginPhrase(h.limit_avg - h.level, 'average'));
      if (h.limit_qp !== null) lines.push(marginPhrase(h.limit_qp - h.level, 'quasi-peak'));
    } else lines.push(`highest line amplitude: ${frequencyText(h.frequency_hz)} at ${n(h.level)} dBuV`, '(not a detector reading, no limit)');
    const widest = Math.max(...lines.map(l => l.length)) * 6.1, right = x + 12 + widest <= LEFT + plotW - 4, left = x - 12 - widest >= LEFT + 4;
    const lx = right ? x + 12 : left ? x - 12 : LEFT + 8, anchor = right || !left ? 'start' : 'end';
    const first = Math.min(Math.max(y + 18, TOP + 14), TOP + PH - 14 * lines.length);
    out.push(`<circle class="emi-worst-ring" cx="${n(x)}" cy="${n(y)}" r="7"/>`);
    lines.forEach((l, k) => out.push(`<text class="emi-worst${k ? '' : ' head'}" x="${n(lx)}" y="${n(first + 14 * k)}" text-anchor="${anchor}">${esc(l)}</text>`));
  }
  // Legend: only what is drawn.
  const entries = [];
  const anyOver = spec.harmonics.some(overAvg), hasBands = spec.harmonics.some(h => h.low !== null && h.high !== null && h.high - h.low > 0.05);
  const base = hasBands ? 'harmonic at the high end of its band' : 'harmonic';
  if (anyOver) { entries.push(['dot', `${base}, not above the average limit`]); entries.push(['dot over', 'harmonic above the average limit']); } else entries.push(['dot', spec.showLimits && spec.drawLimits ? `${base}, not above the average limit` : base]);
  if (spec.lines.qp.length) entries.push(['line qp', `quasi-peak limit${spec.standard ? ` (${spec.standard})` : ''}`]);
  if (spec.lines.avg.length) entries.push(['line avg', 'average limit']);
  if (hasBands) entries.push(['band', 'band: rule-of-thumb inputs']);
  const ly = TOP + PH + (below ? 62 : 52);
  entries.forEach(([kind, text], i) => {
    const lx = LEFT, y = ly + i * 15;
    const sw = kind.startsWith('dot') ? `<circle class="emi-harmonic${kind.includes('over') ? ' over' : ''}" cx="${lx + 8}" cy="${y - 4}" r="3"/>` : kind === 'band' ? `<rect class="emi-band" x="${lx + 4}" y="${y - 11}" width="8" height="12"/>` : `<line class="emi-limit ${kind.split(' ')[1]}" x1="${lx}" y1="${y - 4}" x2="${lx + 16}" y2="${y - 4}"/>`;
    out.push(`${sw}<text class="emi-tick" x="${lx + 22}" y="${y}">${esc(text)}</text>`);
  });
  out.push('</svg>');
  return out.join('');
}

// ---- Board overlay geometry -------------------------------------------------------------------
const EPS = 1e-6;
const samePoint = (a, b) => Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS;
const validPoint = (p, len) => Array.isArray(p) && p.length >= len && p.slice(0, len).every(v => typeof v === 'number' && Number.isFinite(v));
/** The closed loop from `loop_path_3d_mm`: solid legs on the component layer (the first vertex's z), dashed legs on another, a via marker at each z step. */
export function loopFromPath(path) {
  const pts = list(path).filter(p => validPoint(p, 3));
  if (pts.length < 3) return null;
  const z0 = pts[0][2], segments = [], vias = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    if (samePoint(a, b)) { if (Math.abs(a[2] - b[2]) > EPS) vias.push({at: [a[0], a[1]], from_z: a[2], to_z: b[2]}); continue; }
    segments.push({from: [a[0], a[1]], to: [b[0], b[1]], solid: Math.abs(a[2] - z0) < EPS && Math.abs(b[2] - z0) < EPS, z: [a[2], b[2]]});
  }
  return {source: 'loop_path_3d_mm', segments, vias, reference_z: z0, levels: [...new Set(pts.map(p => p[2]))].sort((a, b) => b - a)};
}
const polygonLoop = (points, source) => {
  const pts = list(points).filter(p => validPoint(p, 2));
  return pts.length < 3 ? null : {source, segments: pts.map((a, i) => ({from: [a[0], a[1]], to: [pts[(i + 1) % pts.length][0], pts[(i + 1) % pts.length][1]], solid: true, z: null})), vias: [], reference_z: null, levels: []};
};
const padsOf = (scene, name, exclude) => {
  const comp = scene.components.find(c => c.reference === name);
  const net = scene.nets.find(x => x.name === name);
  const pads = comp ? comp.pads.map(p => ({component: comp.reference, pad: p})) : net ? scene.components.flatMap(c => c.pads.filter(p => p.net === name).map(p => ({component: c.reference, pad: p}))) : [];
  return pads.filter(p => p.component !== exclude);
};
function padDistance(a, b) {
  const A = padCorners(a), B = padCorners(b);
  let best = Infinity;
  for (const [P, Q] of [[A, B], [B, A]]) for (const p of P) for (let i = 0; i < Q.length; i++) best = Math.min(best, distanceToSegment(p, Q[i], Q[(i + 1) % Q.length]));
  return best;
}
const nearestOnPolyline = (p, segments) => {
  let best = null;
  for (const s of segments) {
    const dx = s.to[0] - s.from[0], dy = s.to[1] - s.from[1], d = dx * dx + dy * dy;
    const t = d ? Math.max(0, Math.min(1, ((p[0] - s.from[0]) * dx + (p[1] - s.from[1]) * dy) / d)) : 0;
    const q = [s.from[0] + t * dx, s.from[1] + t * dy], dist = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (!best || dist < best.distance) best = {point: q, distance: dist};
  }
  return best;
};
/** The closest pair of source and victim pads (excluding the cell's own controller), by pad outline. */
export function closestPads(scene, source, victim, exclude) {
  let best = null;
  for (const a of padsOf(scene, source, exclude)) for (const b of padsOf(scene, victim, exclude)) {
    if (a.component === b.component && a.pad.number === b.pad.number) continue;
    const d = padDistance(a.pad, b.pad);
    if (!best || d < best.distance) best = {a, b, distance: d};
  }
  return best;
}
const padRef = (c, p) => ({component: c, number: p.number, position: [...p.position_mm]});
/** The copper of a net (pads, tracks, vias, zone outlines) as one bounding box. */
export function netBounds(scene, name) {
  const pts = [];
  for (const c of scene.components) for (const p of c.pads) if (p.net === name) pts.push(...padCorners(p));
  for (const t of scene.tracks) if (t.net === name) pts.push(...t.points_mm);
  for (const v of scene.vias) if (v.net === name) pts.push(v.position_mm);
  return boundsOf(pts);
}
const pad = (b, r) => b ? [b[0] - r, b[1] - r, b[2] + r, b[3] + r] : null;
/**
 * What the overlay draws for one finding on the open board, with a bounding window for zooming and for the
 * annotation's region. Never throws: a finding with nothing drawable gives `loop: null` and an empty list.
 */
export function overlayGeometry(f, scene, model) {
  const m = f.measures, cell = model.cells.find(c => c.controller === f.cell), notes = [];
  let loop = null;
  if (f.code === 'EMI-HOT-LOOP') {
    loop = loopFromPath(m.loop_path_3d_mm);
    if (!loop) {
      loop = polygonLoop(m.loop_polygon_mm, 'loop_polygon_mm') || polygonLoop(m.pad_polygon_mm, 'pad_polygon_mm');
      if (!loop) {
        const pads = strings(m.pad_sequence).map(refOf).filter(Boolean).map(r => padOf(scene, r.component, r.number)).filter(Boolean);
        loop = polygonLoop(pads.map(p => p.position_mm), 'pad_sequence');
      }
      if (loop) notes.push(`Drawn from the ${loop.source === 'pad_sequence' ? 'pad sequence' : 'pad-centre outline'} (${loop.source}); this report has no traced path, so the loop is a placement estimate.`);
    }
    if (!loop) {
      const boxes = f.objects.map(o => scene.components.find(c => c.reference === o)?.bounds_mm).filter(Boolean);
      const b = joinBounds(boxes);
      if (b) { loop = {source: 'bounds', segments: [[b[0], b[1], b[2], b[1]], [b[2], b[1], b[2], b[3]], [b[2], b[3], b[0], b[3]], [b[0], b[3], b[0], b[1]]].map(s => ({from: [s[0], s[1]], to: [s[2], s[3]], solid: true, z: null})), vias: [], reference_z: null, levels: []}; notes.push('The report holds no loop geometry; the box is the span of the loop\'s parts.'); }
    }
  }
  const switchNets = [];
  if (f.code === 'EMI-SWITCH-NODE') switchNets.push(...f.nets.filter(x => scene.nets.some(n => n.name === x)));
  if (f.code === 'EMI-PROXIMITY' && m.source_kind === 'switch_node' && scene.nets.some(x => x.name === m.source)) switchNets.push(m.source);
  // Victims: the closest pair for a proximity finding; the field victims' pads for a hot loop.
  const victims = [];
  if (f.code === 'EMI-PROXIMITY' && m.source && m.victim) {
    const pair = closestPads(scene, String(m.source), String(m.victim), f.cell);
    if (pair) {
      const reported = num(m.distance_mm);
      victims.push({kind: m.victim_kind || 'victim', name: String(m.victim), source: padRef(pair.a.component, pair.a.pad), pad: padRef(pair.b.component, pair.b.pad), from: [...pair.a.pad.position_mm], to: [...pair.b.pad.position_mm], distance_mm: reported ?? pair.distance, measured_here_mm: pair.distance, reported_mm: reported});
      if (reported !== null && Math.abs(reported - pair.distance) > 0.3) notes.push(`The line joins the closest pads on this board (${n(pair.distance)} mm apart); the report states ${n(reported)} mm, which may be measured from the part's outline or on another revision.`);
    } else notes.push('The source and victim of this proximity finding were not found on this board, so no line is drawn.');
  }
  if (f.code === 'EMI-HOT-LOOP') {
    for (const v of list(m.field_victims).filter(isObject)) for (const text of strings(v.pads)) {
      const r = refOf(text), p = r && padOf(scene, r.component, r.number);
      if (!p) continue;
      const near = loop ? nearestOnPolyline(p.position_mm, loop.segments) : null;
      victims.push({kind: v.kind || 'victim', name: String(v.name ?? text), pad: padRef(r.component, p), source: null, from: near ? near.point : null, to: [...p.position_mm], distance_mm: near ? near.distance : null, measured_here_mm: near ? near.distance : null, reported_mm: null});
    }
  }
  const boxes = [];
  if (loop) boxes.push(boundsOf(loop.segments.flatMap(s => [s.from, s.to])));
  // A hot loop is framed by its own copper; the field victims can be far away. A proximity finding is its victim line.
  if (f.code !== 'EMI-HOT-LOOP') for (const v of victims) boxes.push(boundsOf([v.to, ...(v.from ? [v.from] : [])]));
  for (const net of switchNets) boxes.push(netBounds(scene, net));
  if (!boxes.some(Boolean)) {
    // Conducted findings and the like: the cell's own hot loop window, else the cell's parts.
    const hot = model.findings.find(x => x.code === 'EMI-HOT-LOOP' && x.cell === f.cell);
    const own = hot && hot !== f ? overlayGeometry(hot, scene, model) : null;
    if (own?.bounds) boxes.push(own.bounds);
    else boxes.push(...[f.cell, cell?.magnetic, cell?.catch_diode, ...f.objects].map(o => scene.components.find(c => c.reference === o)?.bounds_mm).filter(Boolean));
  }
  if (f.code === 'EMI-HOT-LOOP' && victims.length) notes.push('Teal rings and dashed lines mark pads of sensitive nets and cable connectors that the report lists as field victims, with their distance from the loop measured on this board.');
  const bounds = pad(joinBounds(boxes), 0.5);
  return {loop, switchNets, victims, bounds, notes};
}
/** Every finding's geometry on the board, for drawing and picking. Computed once per board and report. */
export function overlayAll(scene, model) {
  return new Map(model.findings.map(f => [f.id, overlayGeometry(f, scene, model)]));
}
/** The finding whose overlay line passes within `tolerance` mm of `point`, nearest first, else null. */
export function pickFinding(point, overlays, tolerance, {switchCopper = null} = {}) {
  let best = null;
  const consider = (id, d) => { if (d <= tolerance && (!best || d < best.distance)) best = {id, distance: d}; };
  for (const [id, o] of overlays) {
    if (o.loop) for (const s of o.loop.segments) consider(id, distanceToSegment(point, s.from, s.to));
    if (o.loop) for (const v of o.loop.vias) consider(id, Math.hypot(point[0] - v.at[0], point[1] - v.at[1]) - 0.3);
    for (const v of o.victims) { if (v.from) consider(id, distanceToSegment(point, v.from, v.to)); consider(id, Math.hypot(point[0] - v.to[0], point[1] - v.to[1]) - 0.4); }
    if (switchCopper) for (const net of o.switchNets) if (switchCopper(net, point)) consider(id, 0);
  }
  return best?.id ?? null;
}

// ---- Feedback ---------------------------------------------------------------------------------
/** Compact, report-faithful summary of a finding for an exported annotation (`context.emi_findings`). */
export function emiBrief(f, overlay = null) {
  const m = f.measures, e = f.estimate;
  const key = {};
  for (const k of ['loop_inductance_nh', 'loop_area_mm2', 'traced_path_length_mm', 'distance_mm', 'threshold_mm', 'copper_area_mm2', 'capacitance_to_plane_pf', 'hot_loop_inductance_nh']) if (num(m[k]) !== null) key[k] = m[k];
  const w = f.code === 'EMI-CONDUCTED' ? worstOf(f) : null;
  if (w) key.worst_harmonic = {frequency_hz: w.frequency_hz, level_dbuv: w.total_dbuv, margin_avg_db: num(w.margin_avg_db), margin_qp_db: num(w.margin_qp_db)};
  return {id: f.id, cell: f.cell, code: f.code, severity: f.severity, message: f.message.length > 600 ? `${f.message.slice(0, 597)}...` : f.message, nets: f.nets, objects: f.objects,
    margin_db: f.margin_db, estimate: e ? {quantity: e.quantity ?? null, value: num(e.value), unit: e.unit ?? null, frequency_hz: num(e.frequency_hz), kind: e.kind ?? null} : null,
    ...(Object.keys(key).length ? {key_measures: key} : {}), tags: f.tags, window_mm: overlay?.bounds ? overlay.bounds.map(v => Math.round(v * 1e6) / 1e6) : null};
}
/** The source block an export records when a note cites findings. The report names no board hash, so `board_verified` is false. */
export function emiSource(model) {
  const s = model.source;
  return {schema: s.emi_schema || EMI_SECTION_PREFIX + 'v0.1', report_schema: s.report_schema, file: s.file, board_name: s.board_name, evidence_grade: 'screening', report_sha256: s.report_sha256 || null, board_verified: false,
    note: 'Screening estimates from copper emi-check, not a compliance measurement. Finding ids (E1, E2, ...) count the findings of this report in order and mean nothing for another run.'};
}

/** One short number for the list row of a finding. */
export function findingHeadline(f, model) {
  const m = f.measures;
  if (f.code === 'EMI-HOT-LOOP') return num(m.loop_inductance_nh) !== null ? `${n(m.loop_inductance_nh)} nH${f.margin_db !== null ? `, ${marginPhrase(f.margin_db, 'radiated').replace(' limit', '')}` : ''}` : '';
  if (f.code === 'EMI-CONDUCTED') {
    const s = spectrumModel(f, model);
    if (!s || s.worstIndex === null) return '';
    const w = s.harmonics[s.worstIndex];
    return s.showLimits && w.limit_avg !== null ? `${frequencyText(w.frequency_hz)}, ${marginPhrase(w.limit_avg - w.level, 'average').replace(' limit', '')}` : `${frequencyText(w.frequency_hz)}, ${n(w.level)} dBuV`;
  }
  if (f.code === 'EMI-SWITCH-NODE') return num(m.copper_area_mm2) !== null ? `${n(m.copper_area_mm2)} mm², ranking` : 'ranking';
  if (f.code === 'EMI-PROXIMITY') return `${m.victim ?? ''}${num(m.distance_mm) !== null ? `, ${n(m.distance_mm)} mm` : ''}`.replace(/^, /, '');
  return f.estimate && num(f.estimate.value) !== null ? `${n(f.estimate.value)} ${f.estimate.unit || ''}`.trim() : '';
}
/** The cell's conducted finding, whose spectrum the chart shows for any finding of that cell. */
export const conductedOf = (model, cell) => model.findings.find(f => f.code === 'EMI-CONDUCTED' && f.cell === cell && spectrumModel(f, model)) || null;
/** A chart title and subtitle in CopperScript's wording. */
export function spectrumCaption(spec) {
  const what = spec.showLimits ? 'conducted emission' : spec.receiverEmulation ? 'conducted line amplitudes (NOT detector readings)' : 'conducted line amplitudes, NOT a detector reading';
  const title = `${spec.cell}: ${what} at the input${spec.frequency_hz ? `, switching at ${frequencyText(spec.frequency_hz)}` : ''}${spec.scenario ? ` (${spec.scenario})` : ''}`;
  const limits = spec.detectorReason && !spec.receiverEmulation ? `no limit lines and no margin, the isolated-line assumption fails: ${spec.detectorReason}` : spec.standard ? `limit lines: ${spec.standard}, CISPR 32 mains-port, table unverified (reference for a DC input)` : 'no emission standard with a conducted table is declared: levels only, no limit lines';
  return {title, subtitle: `dBuV at a 50 uH V-network, RMS per harmonic; ${limits}`};
}
