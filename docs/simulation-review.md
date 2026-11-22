# Simulation results review

CopperReview reads the results of a finished `copper sim` run and shows them as a reading tool:
charts first, text second. It does not simulate, re-run or change anything, and it does not check
the results against an open board or schematic (`copper check --sim-results` does that from the
board itself). The verdicts, margins and notes are the solver's, as the run wrote them.

## Where the data comes from

`copper sim BOARD` writes `sim-results.json` (schema `copperscript-sim/v1`) beside one HTML page and
CSV per bench (`--out`, default `build/sim`). The view reads only that JSON, in the browser; it needs
no CopperScript installation. The authoritative description of every field is CopperScript's
`docs/sim-results-schema.md`; the bench pages the CLI writes (`crates/copper-simulate/src/report.rs`)
are the reference for the wording, the step styles and the axis choices used here.

The JSON carries every vector the CSVs do: each step's full x axis (`steps[].x`), every plotted
expression at every step (`plots[].steps[].values`, the whole transient record, not the decimated
copy the pages draw) and every spectrum bin (`spectra[].steps[]`). Checked on the impedance analyzer
run: `Startup.csv` has 3052 + 2814 + 2905 + 3219 rows for its four steps, the same as the JSON;
`Distortion.spectrum.csv` has 9 x 513 bins, the same as the JSON. So the CSVs are never needed for a
v1 file. They are still accepted: if a file lacks a bench's vectors (trimmed by hand, or a step whose
values are missing), the bench says which plots and steps have no values and names the CSV the CLI
wrote; opening that CSV fills only the missing vectors and leaves the others as the JSON has them.
A CSV whose row count differs from the JSON's axis is refused as coming from another run.

What neither file carries: expressions the bench did not plot (other node voltages), complex values
behind a `mag`/`phase` plot, a model's internals, and the pages' decimated copies. The view draws
what is there and says when something is absent, rather than drawing an empty chart.

## Opening results

- **Open → File…** (Ctrl+O) or drop `sim-results.json` on the page. It is recognised by its schema,
  needs no board, and opens the **Simulation** mode (M). Drop the CSVs with it, or after it, to fill
  missing vectors. This works in the static build and the local server alike.
- **Open → Example simulation** (also on the empty page) opens the bundled results of CopperScript's
  `examples/simulation/howland_pump` run (self-written macro models, no vendor model text). The file,
  `copper_review/web/example.sim-results.json`, is that run's JSON with the bench source paths made
  relative to the CopperScript checkout, numbers rounded to 7 significant digits and minified.
- With the local server, `copper-review --sim-results build/sim/sim-results.json` (or
  `make serve SIM=build/sim/sim-results.json`) opens them on load. The server sends the whole
  document with its file name and SHA-256; served to other machines (`--host`), each bench's source
  path is cut to its file name.

The last results opened are remembered in this browser and reopen after a reload. A file of another
schema version (`copperscript-sim/v0.1`, or a newer one) is refused with a message naming both
versions; the results already open stay open. A v1 file written before the optional fields
(`source`, `steps[].pins`, `supplies`, `stress`, `bias_step`) opens, and the view says what it lacks.

## The view

**Benches** (left) lists every bench, sections grouped under their bench, each with its verdict:
pass (filled), fail or error (warning colour), or **no limits** (hollow), a bench whose measures have
no limits and therefore judge nothing. **Failing** and **No limits** filter the list; the search
finds benches by name, measure or plotted expression.

**Overview** shows one tile per bench, then the **failing limits** first (every unsolved bench and
every measure outside its limits, with its worst step, value, limit, margin and how many steps fail),
then all benches with their analysis in words and their measure counts.

A **bench** shows, in order:

- its analysis in words (as the CLI writes it), the verdict, the bench source and the files the CLI
  wrote, and the first failing measure as a badge;
- notes: an unsolved bench's error, a periodic steady state that fell back to settling period by
  period (`steady_fallback`), missing vectors with the CSV to open, parts left out or replaced,
  transient noise;
- the **step legend**: up to eight steps each get a colour and a dash; beyond eight, the stepped
  params are grouped into factors (params that move together are one factor), the factor with the
  most levels up to eight sets the colour, another with up to four the dash, and a factor of more
  levels is drawn on a colour ramp. Clicking a step or a factor level hides or shows its curves in
  every chart of the bench; **Only the worst step of …** isolates one. Plots can be switched off
  one by one;
- the **plots**: one chart per bench (or per time scale), a panel per plotted expression on a shared
  x axis, magnitude-like panels above phase-like ones, the value unit in the panel title. Frequency is
  logarithmic; a start-up record (nearly all change in its first tenth, settling two decades later)
  starts on log time; steps of different lengths share an axis in periods of their own steady state,
  or get one chart per time scale. Noise densities start on a log value axis spanning at least a
  decade. **Log x** / **Log y** switch the scales. Limits are drawn where the results say
  (`measures[].mark`): `min(P)`/`max(P)` as dashed lines, `at(P, x)` as a window with each step's
  value marked, in the warning colour when they fail; a loop gain has its 0 dB and -180 deg lines and,
  with a phase-margin limit, the phase at each step's crossover against the required phase. A limit
  outside the shown range is labelled at the edge with an arrow;
- the **spectra**: a coherent spectrum as stems in dBc against the fundamental, x in harmonics of f0
  up to the 50th; a windowed one in dB relative to 1 of its unit. The region below the integration
  floor is shaded: components there are inside the solver's integration error and not established;
- **measures**: value, limit and margin per step (the distance to the nearer limit, worded
  "0.36 % under max" or "4.75 deg below min"), failing first; the worst step marked. With more than
  eight steps, one row per measure with its worst step and range, and every step in a folded grid.
  A limit scoped by `where` says so, and steps it does not cover are shown as such;
- per step (a selector chooses which): **noise** contributors as share bars by part with every
  generator folded, the **pole map** (natural frequency against damping, right half-plane shaded),
  **Monte Carlo** histograms per measure (limits, nominal, mean and one standard deviation) or the
  **worst-case** corners and sensitivities, **rails** (each supply's current, its driver and where
  the extremes were reached; a step sharing an earlier step's bias point says so and shows that
  step's values), **component stress** and the folded pin voltages;
- the models per fidelity, the transient solver's work per step and the timing when recorded.

### Reading the charts

Hovering reads the nearest curve: the readout under the chart gives x, the step, its value in every
panel and, with up to eight steps shown, every step's value in the hovered panel (a transient drawn in
periods also gives the time). A click places cursor A, a second click cursor B; the readout then gives
both and their difference (with 1/Δx for time, decades and dB per decade for frequency). Drag a box to
zoom (x only, or x and that panel's values when the box is tall), right- or middle-drag (or
Shift-drag) to pan, Ctrl+wheel to zoom under the pointer (Ctrl+Shift+wheel: the value axis), and
double-click or **Reset zoom** to fit. With the chart focused: arrows pan, + and - zoom, 0 resets,
Esc clears the cursors. Long records are drawn as the lowest and highest value of each pixel column,
so no peak is lost; the readout uses every sample.

## Limits

- The view trusts the file: verdicts, worst steps and limits are the solver's. Margins are computed
  from the stored value and limits (the bundled example's values are rounded to 7 digits).
- Nothing ties results to an open design: the `source` digests are shown, not checked.
- Pole maps omit roots at the origin (counted below the map); Monte Carlo histograms do not draw a
  limit far beyond the runs (the caption says so).
- No browser integration test drives this view yet; the parsing and derivations are unit-tested
  (`tests/sim.test.js`) and the server's part in `tests/test_server.py`.
