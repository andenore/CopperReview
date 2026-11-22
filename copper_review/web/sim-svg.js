/* Small static figures of the simulation view as SVG text: a Monte Carlo histogram, the pole map and
 * noise shares. Built from numbers and escaped text only; colours come from CSS classes, so they follow
 * the theme. No DOM, so Node's tests can check them. */
import {formatQuantity, significant} from './sim.js';
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const r1 = v => Math.round(v * 10) / 10;
/** Labels at the ends of an axis are anchored inward so they are never clipped. */
const anchor = (x, lo, hi) => x > hi - 24 ? 'end' : x < lo + 24 ? 'start' : 'middle';
function niceTicks(lo, hi, target) {
  const span = hi - lo || Math.abs(hi) || 1, raw = span / target, mag = 10 ** Math.floor(Math.log10(raw)), step = ([1, 2, 2.5, 5, 10].find(s => span / (s * mag) <= target + 0.5) || 10) * mag;
  const out = []; for (let k = Math.ceil(lo / step - 1e-9); k <= Math.floor(hi / step + 1e-9) && out.length < 20; k++) out.push(k * step); return out;
}
/**
 * A histogram of one measure's Monte Carlo runs: bars (outside the limits in the warning colour),
 * the limits as dashed lines, the nominal value as a solid line and the mean with one standard
 * deviation either side as a bracket.
 */
export function histogramSvg(h, row) {
  const W = 320, H = 150, L = 34, R = 10, T = 18, B = 34, pw = W - L - R, ph = H - T - B, m = row.measure;
  const lims = [row.limit.min, row.limit.max].filter(v => v !== null);
  let lo = h.lo, hi = h.hi;
  for (const v of [...lims, row.nominal].filter(v => v !== null)) if (v >= lo - (hi - lo) * 0.5 && v <= hi + (hi - lo) * 0.5) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const pad = (hi - lo) * 0.04; lo -= pad; hi += pad;
  const x = v => L + (v - lo) / (hi - lo) * pw, y = c => T + ph - c / h.peak * ph;
  const fmt = v => formatQuantity(v, m.units, m.dimension, {digits: 3});
  const out = [`<svg class="sim-hist" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${m.name}: ${h.n} runs from ${fmt(h.lo)} to ${fmt(h.hi)}`)}">`];
  out.push(`<rect class="sim-svg-frame" x="${L}" y="${T}" width="${pw}" height="${ph}"/>`);
  for (const b of h.bins) { const x0 = x(b.lo), x1 = x(b.hi); out.push(`<rect class="sim-bar${b.outside ? ' fail' : ''}" x="${r1(x0 + 0.5)}" y="${r1(y(b.count))}" width="${r1(Math.max(1, x1 - x0 - 1))}" height="${r1(T + ph - y(b.count))}"><title>${esc(`${fmt(b.lo)} to ${fmt(b.hi)}: ${b.count} runs`)}</title></rect>`); }
  const ticks = niceTicks(lo, hi, 3).filter(t => t >= lo && t <= hi);
  for (const t of ticks) out.push(`<line class="sim-svg-tick" x1="${r1(x(t))}" y1="${T + ph}" x2="${r1(x(t))}" y2="${T + ph + 4}"/><text class="sim-svg-label" x="${r1(x(t))}" y="${T + ph + 15}" text-anchor="${anchor(x(t), L, L + pw)}">${esc(fmt(t))}</text>`);
  out.push(`<text class="sim-svg-label" x="${L - 4}" y="${T + 4}" text-anchor="end">${h.peak}</text><text class="sim-svg-label" x="${L - 4}" y="${T + ph}" text-anchor="end">0</text>`);
  for (const [v, side] of [[row.limit.min, 'min'], [row.limit.max, 'max']]) if (v !== null && v >= lo && v <= hi) out.push(`<line class="sim-svg-limit" x1="${r1(x(v))}" y1="${T}" x2="${r1(x(v))}" y2="${T + ph}"/><text class="sim-svg-limit-text" x="${r1(x(v) + (side === 'max' ? -3 : 3))}" y="${T - 5}" text-anchor="${side === 'max' ? 'end' : 'start'}">${side}</text>`);
  if (row.nominal !== null && row.nominal >= lo && row.nominal <= hi) out.push(`<line class="sim-svg-nominal" x1="${r1(x(row.nominal))}" y1="${T}" x2="${r1(x(row.nominal))}" y2="${T + ph}"><title>${esc(`nominal ${fmt(row.nominal)}`)}</title></line>`);
  if (row.mean !== null && row.std !== null) { const a = Math.max(L, x(row.mean - row.std)), b = Math.min(L + pw, x(row.mean + row.std)), yy = T + ph + 24; out.push(`<path class="sim-svg-std" d="M${r1(a)} ${yy - 3}V${yy}H${r1(b)}V${yy - 3}M${r1(x(row.mean))} ${yy - 4}V${yy + 2}"><title>${esc(`mean ${fmt(row.mean)}, std ${fmt(row.std)}`)}</title></path>`); }
  out.push('</svg>');
  return out.join('');
}
/**
 * The poles (×) and zeros (○) of one step on natural frequency (log) against damping ratio: 1 for a
 * decaying real pole, 0 to 1 for a decaying pair, below 0 when it grows (right half-plane, warning colour).
 * Roots at the origin have no place on a log axis and are counted below it.
 */
export function poleMapSvg(entry) {
  const W = 520, H = 210, L = 46, R = 12, T = 12, B = 40, pw = W - L - R, ph = H - T - B;
  const roots = [...entry.poles.map(r => ({...r, kind: 'pole'})), ...entry.zeros.map(r => ({...r, kind: 'zero'}))];
  const placed = roots.filter(r => r.frequency_hz > 0 && r.damping !== null);
  const fs = placed.map(r => Math.log10(r.frequency_hz));
  let lo = fs.length ? Math.floor(Math.min(...fs)) : 0, hi = fs.length ? Math.ceil(Math.max(...fs)) : 1; if (hi === lo) hi = lo + 1;
  const dmin = Math.min(-0.2, ...placed.map(r => Math.max(-2, r.damping))), dmax = 1.1;
  const x = f => L + (Math.log10(f) - lo) / (hi - lo) * pw, y = d => T + (dmax - Math.max(-2, Math.min(dmax, d))) / (dmax - dmin) * ph;
  const out = [`<svg class="sim-poles" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${entry.poles.length} poles and ${entry.zeros.length} zeros on natural frequency against damping`)}">`];
  out.push(`<rect class="sim-svg-unstable" x="${L}" y="${r1(y(0))}" width="${pw}" height="${r1(T + ph - y(0))}"/>`);
  const every = Math.max(1, Math.ceil((hi - lo) / 6));
  for (let d = lo; d <= hi; d++) out.push(`<line class="sim-svg-grid" x1="${r1(x(10 ** d))}" y1="${T}" x2="${r1(x(10 ** d))}" y2="${T + ph}"/>${(d - lo) % every ? '' : `<text class="sim-svg-label" x="${r1(x(10 ** d))}" y="${T + ph + 14}" text-anchor="${anchor(x(10 ** d), L, L + pw)}">${esc(formatQuantity(10 ** d, 'Hz', 'Frequency', {digits: 3}))}</text>`}`);
  for (const d of [1, 0.707, 0.5, 0]) out.push(`<line class="sim-svg-grid${d === 0 ? ' major' : ''}" x1="${L}" y1="${r1(y(d))}" x2="${L + pw}" y2="${r1(y(d))}"/><text class="sim-svg-label" x="${L - 4}" y="${r1(y(d) + 3)}" text-anchor="end">${d}</text>`);
  out.push(`<rect class="sim-svg-frame" x="${L}" y="${T}" width="${pw}" height="${ph}"/>`);
  out.push(`<text class="sim-svg-label" x="${L + pw / 2}" y="${H - 6}" text-anchor="middle">natural frequency (log) · below 0 damping: grows (right half-plane)</text>`);
  out.push(`<text class="sim-svg-label" transform="translate(11,${T + ph / 2}) rotate(-90)" text-anchor="middle">damping ratio</text>`);
  for (const r of placed) {
    const X = r1(x(r.frequency_hz)), Y = r1(y(r.damping)), bad = r.kind === 'pole' && r.right_half_plane;
    const title = esc(`${r.kind} ${formatQuantity(r.frequency_hz, 'Hz', 'Frequency')}, damping ${significant(r.damping, 3)}${r.real ? ' (real)' : ''}${r.nodes.length ? `; ${r.nodes.slice(0, 3).join(', ')}` : ''}`);
    out.push(r.kind === 'pole' ? `<path class="sim-svg-pole${bad ? ' fail' : ''}" d="M${X - 4} ${Y - 4}L${X + 4} ${Y + 4}M${X - 4} ${Y + 4}L${X + 4} ${Y - 4}"><title>${title}</title></path>` : `<circle class="sim-svg-zero" cx="${X}" cy="${Y}" r="4"><title>${title}</title></circle>`);
  }
  out.push('</svg>');
  const origin = roots.length - placed.length;
  return {svg: out.join(''), origin};
}
/** Noise contributors as horizontal bars of their share of the output noise power, largest first. */
export function noiseSharesSvg(rows, total) {
  const shown = rows.slice(0, 10), rest = rows.slice(10), all = rest.length ? [...shown, {owner: `${rest.length} others`, share: rest.reduce((a, b) => a + b.share, 0), rms_v: Math.sqrt(rest.reduce((a, b) => a + b.rms_v ** 2, 0)), parts: []}] : shown;
  const W = 520, row = 20, L = 150, R = 150, H = all.length * row + 8, pw = W - L - R;
  const out = [`<svg class="sim-shares" viewBox="0 0 ${W} ${H}" role="img" aria-label="Noise contributors by share of the output noise power">`];
  all.forEach((c, i) => {
    const y = 4 + i * row, w = Math.max(1, (c.share || 0) * pw), name = c.owner.length > 22 ? `${c.owner.slice(0, 21)}…` : c.owner;
    out.push(`<text class="sim-svg-label strong" x="${L - 6}" y="${y + 13}" text-anchor="end">${esc(name)}<title>${esc(c.parts.join(', ') || c.owner)}</title></text>`);
    out.push(`<rect class="sim-bar" x="${L}" y="${y + 3}" width="${r1(w)}" height="${row - 6}"/>`);
    out.push(`<text class="sim-svg-label" x="${L + w + 6}" y="${y + 13}">${esc(`${significant((c.share || 0) * 100, 3)} % · ${formatQuantity(c.rms_v, 'V', 'Voltage', {digits: 3})} rms`)}</text>`);
  });
  out.push('</svg>');
  return out.join('');
}
export {esc};
