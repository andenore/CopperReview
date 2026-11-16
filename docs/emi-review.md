# EMI screening review

CopperReview can show the EMI screening that CopperScript stores in a run, next to the
board, and let you cite its findings in layout notes. **Everything here is a screening
estimate**: it ranks likely noise sources and flags layout choices worth a second look. It is
not a compliance measurement, not a pass or fail, and no estimate has been correlated with a
measurement. The panel says so, and so does every export.

## Where the data comes from

`copper emi-check BOARD --run RUN --write` and `copper route-board` store the screening in the
run's `route-report.json` under the top-level key `emi` (schema `copperscript-emi-check/v0.1`).
There is deliberately no sidecar file: that one report stays the single file of a run.
CopperReview reads only that section, as JSON, in the browser. It needs no CopperScript
installation and does not change the bundled WASM compiler. The authoritative description of
the fields and the model is CopperScript's `docs/emi-noise-analysis.md`; the pictures
CopperScript itself draws (`copper emi-check --plot-spectrum`, `--plot-field`) are the reference
for the wording and legends used here.

## Opening a report

Open the board first (a CopperScript `.kicad_pcb` export, or a saved scene), then the report:

- **Open → File…** (Ctrl+O) or drop `route-report.json` on the page. It is recognised by its
  schema (`copperscript-route-board/…`, or a bare `copperscript-emi-check/…` document). Select
  the board and the report together and they open in the right order. This works in the
  static build and the local server alike.
- With the local server, `copper-review RUN/board.kicad_pcb --route-report RUN/route-report.json`
  (or `make serve BOARD=… REPORT=…`) opens it with the board. The server sends the page only
  the `emi` section, the file's name and its SHA-256, never the rest of the report.

Without the `emi` section, with an `error` recorded by CopperScript, or with an older schema,
the report still opens and a note in the panel says what is missing. A report written before the
traced loop path existed (`loop_path_3d_mm`) draws the hot loop from its pad-centre outline,
then its pad sequence, then the box of its parts, and says which one it used. The report names no
board hash, so CopperReview can only check that the parts it names exist on the open board; the
panel says that this is not proof the two belong together.

## The panel

**EMI** (toolbar button, shown once a report is open) opens a panel under the board, with:

- the converter cells and their findings, each with one headline number (hot-loop inductance
  and radiated margin, worst conducted harmonic with its margin, switch-node copper area,
  proximity distance);
- the selected finding: the report's message, key numbers (inductance, loop area, worst harmonic
  against the quasi-peak and average limits, anti-resonances, capacitor branches with their current
  share), the assumptions as plain sentences (tags the table does not know are shown as their own
  words), the solver's own assumptions and the `not_modelled` mechanisms, both folded;
- the conducted spectrum of the finding's cell (below).

Margins are worded one way only: "12.3 dB over the average limit" or "4.1 dB under the quasi-peak
limit". Common-mode coupling of the switch node is a ranking score and is never drawn against a
limit.

### Spectrum

Harmonics are markers at the high end of their band with the band as a whisker behind them, an
envelope through them, and the worst harmonic ringed with its margins. The CISPR 32 mains-port
quasi-peak and average limit lines (class A or B, as the report states) are drawn across the whole
150 kHz to 30 MHz band only when the report says the levels are detector readings (isolated
harmonic lines). Otherwise the chart shows line amplitudes, says so, and draws no limit and no
margin. The limit tables are transcribed by CopperScript and marked unverified there as well; a
mains-port limit is only a reference for a DC input.

## The board overlay

The **EMI screening overlay** layer (left panel, with the other layers) draws, for the selected
finding in full and for the others faintly:

- the **hot loop** from `loop_path_3d_mm`: solid on the layer of the path's first vertex (the
  component layer), dashed for legs at another z, a ring at every z step (a via). The path carries z
  only, so CopperReview cannot name the layer of a dashed leg. Without a path, a thin dotted
  outline marks a placement estimate instead;
- the **switch-node copper** (tracks, vias, pads and fills of the net) for a switch-node finding and
  for a proximity finding whose source is the switch node;
- the **victims**: for a proximity finding the closest pair of source and victim pads, joined by a
  line labelled with the report's distance; for a hot loop the pads of the sensitive nets and cable
  connectors the report lists as field victims, joined to the nearest point of the loop and labelled
  with that distance measured on the board.

Selecting a finding in the panel zooms to it and highlights it. Clicking the loop, a victim line or
(with the Component tool) switch-node copper on the board selects its finding. Pads keep their normal
meaning, and a click never changes your note.

## Citing a finding in a layout note

**Cite in layout note** (or typing ids into **Cites EMI findings**) adds the finding's id, `E1`,
`E2`, … (its position in the report, valid for that report only), to the layout note. If nothing else
is selected, the finding's window becomes the note's region. The finding then travels in the exported
review as a compact brief; see [the output contract](review-format.md#emi-findings). The note
itself stays an observation: the brief is evidence for the next iteration, not a constraint.

## Limits

- Screening evidence only; no margin is a pass or fail.
- The report names no board hash and no source revision, so nothing proves the report belongs to the
  open board.
- Conducted levels are differential mode; common mode is not modelled. The radiated estimate is
  the hot loop's free-space differential-mode field.
- A proximity finding's line joins the closest pads CopperReview finds on the board for the
  source and victim the report names; the report's distance may be measured differently (from a
  part outline, for example) and is the number shown.
- The view has no z-to-layer table, so a dashed leg is "not the component layer", nothing more.
