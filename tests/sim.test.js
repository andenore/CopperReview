import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {readSim, simDocumentKind, analysisText, verdictLine, benchGroups, failures, measureCells, marginOf, marginText, formatQuantity, significant, stepStyles, factors,
  plotFigures, timeLayout, spectrumFigure, histogram, variationRows, railsAt, missingVectors, mergeCsv, phaseMarginMarks, noiseByOwner, noiseAt, SIM_SCHEMA} from '../copper_review/web/sim.js';
import {histogramSvg, poleMapSvg, noiseSharesSvg} from '../copper_review/web/sim-svg.js';
// copper_review/web/example.sim-results.json is `copper sim` on CopperScript's examples/simulation/howland_pump
// (self-written macro models, no vendor model text): bench source paths made relative to the CopperScript
// checkout, numbers rounded to 7 significant digits, minified.
const raw = () => JSON.parse(readFileSync(new URL('../copper_review/web/example.sim-results.json', import.meta.url)));
const model = readSim(raw(), {name: 'example.sim-results.json', sha256: 'a'.repeat(64)});
const bench = (m, name) => m.benches.find(b => b.name === name);

test('the bundled example is recognised and read: benches, verdicts, words', () => {
  assert.equal(simDocumentKind(raw()), 'sim-results');
  assert.equal(simDocumentKind({schema: 'copperscript-sim/v9'}), 'sim-results', 'any version is recognised, then refused by readSim');
  assert.equal(simDocumentKind({schema: 'copperscript-route-board/v1'}), null);
  assert.equal(simDocumentKind(null), null);
  assert.equal(model.error, null);
  assert.deepEqual(model.notes, []);
  assert.equal(model.board, 'HowlandPump'); assert.equal(model.status, 'pass'); assert.equal(model.benches.length, 8);
  assert.deepEqual(model.benches.map(b => b.verdict), Array(8).fill('pass'));
  assert.deepEqual(benchGroups(model).map(g => [g.name, g.benches.length]), [['CurrentFlatness', 1], ['MeasurementNoise', 1], ['OutputImpedance', 1], ['ResistorMatching', 1], ['Stability', 3], ['StepResponse', 1]]);
  assert.equal(analysisText(bench(model, 'CurrentFlatness')), 'ac 1 kHz to 1 MHz, 20 points per decade');
  assert.equal(analysisText(bench(model, 'StepResponse')), 'tran 0 to 2 us, max step 2 ns');
  assert.equal(analysisText(bench(model, 'Stability.pump')), 'loop gain at U1.OUT (net DRIVE) 1 kHz to 10 GHz, 40 points per decade');
  assert.equal(analysisText(bench(model, 'MeasurementNoise')), 'noise of V(LOAD) referred to J_IN, 1 kHz to 1 MHz, 20 points per decade, 300.15 K');
  assert.equal(analysisText(bench(model, 'Stability.poles')), 'poles');
  assert.equal(verdictLine(bench(model, 'MeasurementNoise')), '2 of 2 limited measures pass · 5 without limits');
  assert(!JSON.stringify(raw()).includes('Users'), 'no local path in the bundled example');
});

test('values are written in engineering units, ratios in percent', () => {
  assert.equal(formatQuantity(1.5e-5, 'A', 'Current'), '15 uA');
  assert.equal(formatQuantity(0.00123, '1', 'Ratio'), '0.123 %');
  assert.equal(formatQuantity(67526045, '1/s', 'Frequency'), '67.53 MHz');
  assert.equal(formatQuantity(5.06e-12, 'A*s^(1/2)', 'CurrentNoiseDensity'), '5.06 pA/rtHz');
  assert.equal(formatQuantity(1e7, 'V/A', 'Resistance'), '10 Mohm');
  assert.equal(formatQuantity(0.5, 'V/A', 'Resistance'), '500 mohm');
  assert.equal(formatQuantity(999.96, 'V', 'Voltage'), '1 kV', 'rounding carries into the next unit');
  assert.equal(formatQuantity(-3.0103, 'dB', 'Gain'), '-3.01 dB');
  assert.equal(formatQuantity(3.2e-9, 's^(1/2)', null), '3.2e-9 1/rtHz');
  assert.equal(formatQuantity(null, 'V', 'Voltage'), '-');
  assert.equal(formatQuantity(1, 'V', 'Voltage', {never: true}), 'never');
  assert.equal(significant(0.023456, 3), '0.0235');
});

test('each measure gives its value, limit and margin per step, worded by direction', () => {
  const flat = bench(model, 'CurrentFlatness').measures.find(m => m.name === 'flatness');
  const cells = measureCells(flat);
  assert.deepEqual(cells.map(c => c.value), ['0.114 %', '0.1292 %', '0.6388 %']);
  assert.deepEqual(cells.map(c => c.limit), ['max 1 %', 'max 1 %', 'max 1 %']);
  assert.equal(cells[2].marginText, '0.361 % under max'); assert(cells[2].worst); assert.deepEqual(cells.map(c => c.state), ['pass', 'pass', 'pass']);
  const pm = bench(model, 'Stability.pump').measures.find(m => m.name === 'phase_margin');
  assert.equal(measureCells(pm)[0].marginText, '5.25 deg above min');
  assert.equal(marginText(marginOf({value: 2, min: null, max: 1.5, never: false}), {units: 'V', dimension: 'Voltage'}), '500 mV over max');
  assert.equal(marginText(marginOf({value: 1, min: 3, max: null, never: false}), {units: 'dB', dimension: 'Gain'}), '2 dB below min');
  assert.equal(marginOf({value: 1, min: null, max: null, never: false}), null);
  assert.equal(marginOf({value: null, min: 0, max: 1, never: true}), null);
  const crossover = bench(model, 'Stability.pump').measures.find(m => m.name === 'crossover');
  assert.deepEqual(measureCells(crossover).map(c => c.state), ['free', 'free', 'free']);
});

test('failing limits and unsolved benches are listed first, worst step and margin included', () => {
  const doc = raw();
  const b = doc.benches.find(x => x.name === 'Stability.pump'), m = b.measures.find(x => x.name === 'phase_margin');
  m.limits = 'min 25 deg'; m.steps.forEach(s => { s.min = 25; s.pass = s.value >= 25; }); m.status = 'fail'; b.status = 'fail';
  const e = doc.benches.find(x => x.name === 'OutputImpedance'); Object.assign(e, {status: 'error', error: 'no DC path at LOAD', steps: []});
  doc.status = 'error';
  const failing = readSim(doc);
  assert.deepEqual(failing.benches.map(x => x.verdict).filter(v => v !== 'pass'), ['error', 'fail']);
  const list = failures(failing);
  assert.equal(list.length, 2);
  assert.equal(list[0].bench.name, 'OutputImpedance'); assert.equal(list[0].error, 'no DC path at LOAD');
  assert.equal(list[1].measure.name, 'phase_margin'); assert.equal(list[1].failingSteps, 2); assert.equal(list[1].steps, 3);
  assert.equal(list[1].worst.value, '20.25 deg'); assert.equal(list[1].worst.marginText, '4.75 deg below min'); assert.equal(list[1].stepLabel, 'R_LOAD_VALUE = 100 ohm');
  assert.equal(verdictLine(bench(failing, 'Stability.pump')), '1 of 1 limited measure fail · 1 without limits');
  assert(bench(failing, 'OutputImpedance').notes.some(n => n.level === 'error' && /no DC path/.test(n.text)));
  assert.deepEqual(plotFigures(bench(failing, 'OutputImpedance')), [], 'an unsolved bench draws nothing');
  const marks = phaseMarginMarks(bench(failing, 'Stability.pump'), [0, 1, 2]);
  assert.equal(marks.length, 3); assert.equal(marks[0].min, -155); assert.equal(marks[0].fail, true); assert.equal(marks[2].fail, false);
  assert.match(marks[0].label, /phase_margin at crossover: min 25 deg/); assert.equal(marks[1].label, '');
});

test('a file without the optional parts opens, and says what is absent', () => {
  const doc = raw();
  delete doc.source;
  for (const b of doc.benches) { delete b.timing; for (const s of b.steps) { delete s.pins; delete s.supplies; delete s.stress; delete s.bias_step; } }
  const step = doc.benches.find(b => b.name === 'StepResponse'); step.plots[0].steps[1].values = []; delete step.plots[1].steps;
  const flat = doc.benches.find(b => b.name === 'CurrentFlatness'); delete flat.files; delete flat.variation; delete flat.models;
  const m = readSim(doc, {name: 'old.json'});
  assert.equal(m.error, null);
  assert(m.notes.some(n => /No `source` record/.test(n)));
  assert(m.notes.some(n => /Pin voltages and supply currents are not recorded/.test(n)));
  const s = bench(m, 'StepResponse');
  assert.deepEqual(railsAt(s, 0), {supplies: null, stress: null, pins: null, from: null});
  assert.deepEqual(missingVectors(s), [{expression: 'i_load', steps: [1]}, {expression: 'V(DRIVE)', steps: [0, 1, 2]}]);
  assert(s.notes.some(n => n.csv === 'StepResponse.csv' && /open that CSV/.test(n.text)), 'points to the CSV the CLI wrote');
  const [fig] = plotFigures(s);
  assert.deepEqual(fig.panels.map(p => [p.expression, p.missing]), [['i_load', [1]], ['V(DRIVE)', [0, 1, 2]]]);
  const f = bench(m, 'CurrentFlatness');
  assert.deepEqual(f.files, {html: null, csv: null, spectrum_csv: null}); assert.equal(f.variation, null); assert.deepEqual(f.models, []);
});

test('an unknown schema version or another document gives a clear message, not a crash', () => {
  const v2 = readSim({...raw(), schema: 'copperscript-sim/v2'}, {name: 'sim-results.json'});
  assert.equal(v2.benches.length, 0);
  assert.match(v2.error, /sim-results\.json has schema copperscript-sim\/v2; this view reads copperscript-sim\/v1 only/);
  assert.match(v2.error, /newer CopperScript/);
  assert.match(readSim({schema: 'copperscript-sim/v0.1', benches: []}).error, /Run `copper sim` again/);
  assert.match(readSim({schema: 'copper-review/v2'}, {name: 'x.json'}).error, /x\.json is not a copper sim results file/);
  assert.match(readSim('text').error, /not a copper sim results file/);
  // Malformed content inside a v1 document is read as far as it goes.
  const odd = readSim({schema: SIM_SCHEMA, benches: [null, 3, {name: 'B', steps: [{x: [1, 2, null]}], plots: [{expression: 'V(X)', steps: [{values: [1, 'a', 3]}]}], measures: [{name: 'm', steps: 'none'}]}]});
  assert.equal(odd.error, null); assert.equal(odd.benches.length, 1);
  assert.equal(odd.benches[0].verdict, 'error', 'a bench without a status is not claimed to pass');
  assert(Number.isNaN(odd.benches[0].steps[0].x[2])); assert(Number.isNaN(odd.benches[0].plots[0].steps[0][1]));
  assert.equal(odd.benches[0].measures[0].steps[0].value, null);
});

test('the CSV copper sim wrote beside the results fills only the vectors the JSON lacks', () => {
  const doc = raw(), original = doc.benches.find(b => b.name === 'StepResponse');
  const lines = ['step,label,time_s,i_load [A],V(DRIVE) [V]'];
  original.steps.forEach((s, k) => s.x.forEach((t, i) => lines.push([k, `"${s.label}"`, t, original.plots[0].steps[k].values[i] ?? '', original.plots[1].steps[k].values[i] ?? ''].join(','))));
  const csv = lines.join('\n');
  const keep = original.plots[0].steps[2].values.slice();
  original.plots[0].steps[2].values = [];
  const m = readSim(doc);
  const r = mergeCsv(m, 'StepResponse.csv', csv);
  assert.equal(r.bench.name, 'StepResponse'); assert.equal(r.filled, 1);
  assert.deepEqual(r.bench.plots[0].steps[2], keep.map(v => v ?? NaN));
  assert.deepEqual(missingVectors(r.bench), []); assert(!r.bench.notes.some(n => n.csv));
  assert.equal(mergeCsv(m, 'StepResponse.csv', csv).filled, 0, 'nothing left to fill');
  assert.throws(() => mergeCsv(m, 'Other.csv', csv), /not a CSV of a bench in the open results/);
  const m2 = readSim(raw()); bench(m2, 'StepResponse').plots[0].steps[0] = null;
  assert.throws(() => mergeCsv(m2, 'StepResponse.csv', lines.slice(0, 5).join('\n')), /from another run/);
  assert.throws(() => mergeCsv(m2, 'StepResponse.csv', 'a,b\n1,2'), /step,label/);
});

test('beyond eight steps, factors set colour and dash; up to eight each step has its own', () => {
  const few = stepStyles(bench(model, 'CurrentFlatness'));
  assert.deepEqual(few.color, [{palette: 0}, {palette: 1}, {palette: 2}]); assert.deepEqual(few.dash, [0, 1, 2]);
  const q = (value, unit) => ({value, unit, base_value: value});
  const steps = []; for (const r of ['1', '2', '3', '4']) for (const c of ['10', '20', '30']) steps.push({stepped: {R: q(r, 'kohm'), C: q(c, 'pF'), TAG: q(r, '')}});
  const b = {steps};
  assert.deepEqual(factors(b).map(f => [f.names, f.levels.length]), [[['R', 'TAG'], 4], [['C'], 3]], 'params that move together form one factor');
  const st = stepStyles(b);
  assert.equal(st.colorFactor, 0); assert.equal(st.dashFactor, 1); assert.equal(st.ramp, false);
  assert.deepEqual(st.color.slice(0, 4).map(c => c.palette), [0, 0, 0, 1]); assert.deepEqual(st.dash.slice(0, 4), [0, 1, 2, 0]);
  const many = {steps: Array.from({length: 12}, (_, k) => ({stepped: {N: q(String(k), '')}}))};
  const ramp = stepStyles(many); assert.equal(ramp.ramp, true); assert.equal(ramp.color[0].ramp, 0); assert.equal(ramp.color[11].ramp, 1);
});

test('figures: Bode panels with loop references, log axes where the data is log, time layouts', () => {
  const [loop] = plotFigures(bench(model, 'Stability.pump'));
  assert.equal(loop.x.scale, 'log'); assert.equal(loop.x.logDefault, true);
  assert.deepEqual(loop.panels.map(p => [p.expression, p.phase, p.refs.map(r => r.value)]), [['db(loop_gain())', false, [0]], ['phase(loop_gain())', true, [-180]]]);
  const [noise] = plotFigures(bench(model, 'MeasurementNoise'));
  assert(noise.panels.every(p => p.logY), 'noise densities default to a log value axis');
  const [tran] = plotFigures(bench(model, 'StepResponse'));
  assert.equal(tran.x.scale, 'linear'); assert.equal(tran.x.logDefault, false, 'a step response is not a start-up');
  const window = tran.panels[0].marks.find(m => m.kind === 'window');
  assert.equal(window.measure, 'settled_current'); assert.equal(window.at, 2e-6); assert.equal(window.points.length, 3);
  // Steps of different lengths: periods with a steady state at every step, else one figure per time scale.
  const x = n => Array.from({length: 5}, (_, i) => i * n);
  const steady = {analysis: {kind: 'tran', stepped: ['steady_period_s'], steady_period_s: null}, steps: [{x: x(1e-3), analysis: {steady_period_s: 1e-3}}, {x: x(1e-6), analysis: {steady_period_s: 1e-6}}]};
  assert.deepEqual(timeLayout(steady), {kind: 'periods', groups: [[0, 1]], periods: [1e-3, 1e-6]});
  const plain = {analysis: {kind: 'tran', stepped: []}, steps: [{x: x(1e-3), analysis: {}}, {x: x(1e-6), analysis: {}}, {x: x(2e-3), analysis: {}}]};
  assert.deepEqual(timeLayout(plain), {kind: 'groups', groups: [[0, 2], [1]]});
});

test('a coherent spectrum reads in dBc against its fundamental, with its integration floor', () => {
  const f = [0, 500, 1000, 1500, 2000, 3000], a = [1e-3, 1e-9, 2, 1e-9, 0.02, 0.002];
  const b = {steps: [{stepped: {}, label: 'nominal'}], spectra: [{expression: 'spectrum(V(OUT), 1kHz)', units: 'V', coherent: true, steps: [{fundamental_hz: 1000, frequency_hz: f, amplitude: a, integration_floor: 1e-4}]}]};
  const s = spectrumFigure(b, 0);
  assert.equal(s.units, 'dBc'); assert.equal(s.x.harmonics, true);
  assert.deepEqual(s.series[0].x, [0.5, 1, 1.5, 2, 3], '0 Hz is left out');
  assert.deepEqual(s.series[0].y.map(v => Math.round(v)), [-186, 0, -186, -40, -60]);
  assert.equal(s.floor.value, -80);
  b.spectra[0].coherent = false; const w = spectrumFigure(b, 0);
  assert.equal(w.units, 'dB re 1 V'); assert.equal(Math.round(w.floor.value), Math.round(20 * Math.log10(2e-4)));
});

test('Monte Carlo histograms, noise shares and the pole map are drawn from the data', () => {
  const mc = bench(model, 'ResistorMatching');
  assert.equal(mc.variation.method.kind, 'montecarlo'); assert.equal(mc.variation.method.runs, 200);
  const rows = variationRows(mc, 1);
  assert.deepEqual(rows.map(r => [r.name, r.limit.max]), [['current_error', 0.005], ['flatness', 0.01]]);
  const h = histogram(rows[0].values, rows[0].limit);
  assert.equal(h.bins.reduce((n, b) => n + b.count, 0), 200); assert(h.bins.every(b => !b.outside));
  assert(histogram([1, 2, 3, 4], {max: 2.5, bins: 2}).bins[1].outside, 'a bin wholly beyond the limit is marked');
  assert.equal(histogram([NaN]), null);
  const svg = histogramSvg(h, {...rows[0], measure: {...rows[0].measure, name: '<b>&'}});
  assert.match(svg, /^<svg class="sim-hist"/); assert(!svg.includes('<b>&'), 'text is escaped');
  const [entry] = noiseAt(bench(model, 'MeasurementNoise'), 0);
  const owners = noiseByOwner(entry);
  assert.equal(owners[0].owner, 'R_LOAD'); assert(Math.abs(owners.reduce((n, o) => n + o.share, 0) - 1) < 1e-3);
  assert.match(noiseSharesSvg(owners), /R_LOAD/);
  const pz = bench(model, 'Stability.poles').pole_zero[0];
  const map = poleMapSvg(pz); assert.equal(map.origin, 0); assert.equal((map.svg.match(/sim-svg-pole/g) || []).length, pz.poles.length);
  const rails = railsAt(bench(model, 'Stability.pump'), 1);
  assert.equal(rails.from, 0, 'a step sharing an earlier bias point shows that step\'s rails'); assert.equal(rails.supplies.length, 2);
});
