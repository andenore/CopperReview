# CopperReview

[Open CopperReview on GitHub Pages](https://andenore.github.io/CopperReview/).

A review tool for CopperScript designs with two halves that can be open at once:

- **Electrical review** — generated **Schematic** sheets, the **Power** hierarchy and
  **Buses**, from the compiled electrical IR (no layout needed). Double-click or press
  N to note the selection; notes show as numbered markers. See the
  [electrical workflow and contracts](docs/electrical-review.md).
- **Layout review** — the board's placement and routing from a CopperScript board
  export: select components, nets and regions, annotate them, and export a review for
  the next LLM-assisted solver iteration.

**Assembly** (A) uses the same board to track a manual build part by part; see
[Assembly tracking](#assembly-tracking).

The **Electrical · Layout · Both** switch in the top bar picks what is shown (E, L, B).
**Both** puts the schematic and the board side by side with a draggable divider;
selecting a part or net on either side selects and centres it on the other. Parts
match by CopperScript path (or reference) and nets by name; the top bar counts parts
found on only one side (Both stays off when they share no part), and nothing proves the board was built from that exact source.
Outside **Both**, **Show on board** and **Show in schematic** (S) jump across, and
**Source** opens the declaration in the CopperScript project (found by searching the
compiled sources, since the IR does not record source lines yet), with **Open on
GitHub** at the pinned commit or **Open in VS Code** for a project served locally.

Everything opens from one **Open** menu, or by dropping files on the page:
**File…** (Ctrl+O) recognizes a board export, compiled IR, `.copper` source, saved
scene, layout review, electrical review or CopperScript issue list by its contents,
and accepts several at once. Opening a board keeps the open schematic, and the other
way round. **Project folder…** compiles a local project (the folder holding
`board.copper` and `copper.mod`) in the browser: sources never leave the computer,
and only dependencies pinned in `copper.lock` are downloaded from GitHub and checked
against the lock; re-pick the folder after editing. **From URL or GitHub…** compiles
GitHub source projects with local imports and pinned dependencies, or opens direct
HTTPS design files; private repositories need a fine-grained token with Contents:
Read-only (⋯ → **Private GitHub access**), kept in the tab and sent only to
`api.github.com`. See [URL loading and provenance](docs/wasm-hosting.md#open-from-url).
**Export** writes the layout review, the electrical review or the board scene; ⋯
holds the compiler check, the review limits and **Dark mode** (the page is light by
default; the choice is remembered in this browser).

This is a **separate Git project**. Its static browser build reuses CopperScript's
Rust compiler, ERC and queries through a bundled WebAssembly worker. No native
CopperScript installation or hosted backend is required by that build. The local
Python 3.11+ server additionally reads raw `.kicad_pcb` files without KiCad.
See [WASM build, static hosting and current boundaries](docs/wasm-hosting.md).
The board is read-only. Feedback never edits the PCB or solver constraints.

## Run

On Ubuntu (or anywhere with `make`, [uv](https://docs.astral.sh/uv/) and Node.js 20+):

```bash
make setup                                   # check tools, install, fetch the browser compiler
make serve PROJECT=../BysseControl-32        # compile a project folder; reload to recompile
make serve PROJECT=../BysseControl-32 HOST=0.0.0.0 OPEN=no   # reachable from other machines
make serve PROJECT=../BysseControl-32 BOARD=../BysseControl-32/build/board.kicad_pcb   # schematic and board, linked
make serve IR=build/electrical.ir.json       # or a compiled IR; BOARD=… alone for a PCB
make test
```

`PORT` (default 8769), `ENTRY` (board file in a multi-board project) and `STAGE`
(for `BOARD`) are also accepted; `make help` lists the targets. The compiler is
fetched on first use and again whenever `.copperscript-version` changes.

Or run the commands directly. From this repository:

```powershell
python -m copper_review "../CopperAssetTracker/build/placed.kicad_pcb" --stage placed
```

Or use uv to install the local package and run its command:

```powershell
uv run copper-review "../CopperAssetTracker/build/fabrication-review-20261010/finished-routed.kicad_pcb" --stage fully_routed
```

Open the included synthetic example:

```powershell
python -m copper_review examples/demo.kicad_pcb --stage partially_routed
```

Omit the board argument to start with a file picker. `--no-browser` prints the
local URL instead of opening it. `--port 8769` selects a stable port; otherwise
the operating system chooses a free one. Ctrl+C stops the local server.

To attach a source file identity to feedback:

```powershell
python -m copper_review path/to/board.kicad_pcb --source path/to/board.copper --stage partially_routed
```

`--source` records the filename and SHA-256 of that file. It does not compile
the source or establish the identity of transitive dependencies. Existing
CopperScript export commands produce the input; no compiler changes are needed.

To serve a CopperScript project folder and compile it in the browser:

```powershell
npm run fetch:wasm   # once: download the published browser compiler
uv run copper-review --project ../BysseControl-32 --port 8769
```

The server lists and serves only the folder's `.copper` sources,
`copper.mod` / `copper.lock` and `assembly.lock` (skipping `.git`, `.copper-cache`, `node_modules`,
`target` and symlinks), read fresh on every request and only with the session
token. The page compiles them on load, so **reload after editing to recompile**.
Dependencies pinned in `copper.lock` are downloaded from GitHub and checked against
the lock. `--entry boards/main/board.copper` picks the board when the folder has
several; otherwise the page asks.

`--host 0.0.0.0` listens on your network as well and prints a `network:` link per
address. It is plain HTTP: anyone holding the link (with its token) can read the
design and, with `--project`, its sources, so use it only on networks you trust.
The API still requires the token; static files do not. Hashing and note IDs fall
back to built-in implementations because browsers withhold `crypto.subtle` from
non-HTTPS network addresses.

## Review workflow

1. Open an exported board. Choose its review stage explicitly.
2. Pick **Component** to click pads/bodies, or choose a reference in the explorer.
   Pick **Net** to click a pad, track, via, or stored copper fill; the Nets list
   also lets you select a net without visible copper. Shift-click adds/removes
   selections. Component and net selections can be combined.
3. Pick **Region** and drag a rectangle. Shift-drag retains component/net
   selections alongside the region. Coordinates use the native PCB origin,
   millimetres, x right, y down, and a front view for all layers.
4. Write what you observe and the behavior you want improved. Choose category,
   priority, and status; click **Add annotation**. Use **Board-wide observation**
   for a feature request that does not refer to specific geometry.
   To tie a note to a CopperScript run, save the run's issue list with
   `copper issues RUN --json > issues.json` and open it (**Open → File…**). Issue
   windows are drawn on the board and listed in the **Issues** tab; clicking one
   frames it, selects its window as a region and fills **Cites CopperScript
   issues**. The list is rejected when its board hash differs from the open board.
5. Click a saved note to inspect/edit it. Set it to resolved when addressed.
   Add a review summary and **Export → Layout review JSON** or **Copy layout review JSON**.
6. Paste the file contents into an LLM prompt with the relevant CopperScript
   checkout/source available. For example:

   > Use this CopperReview feedback to plan and implement generic placement and
   > routing improvements in CopperScript. Verify the board/source hashes before
   > reproducing the findings. Treat the notes as observations and desired
   > behavior. Build a small reproducer, preserve existing placement/macro intent,
   > and test the algorithm rather than adding a board-specific repair.

Review files are saved as `<board>.review.json`, schema `copper-review/v2`.
See [the output contract](docs/review-format.md), [JSON Schema](docs/review.schema.json),
and [the complete example review](examples/demo.review.json).

Open a saved review (**Open → File…**) to resume notes after opening the exact matching PCB.
Reviews for a different board hash are rejected. **Export → Board scene** writes a
portable `<board>.scene.json`, containing the normalized geometry. Open that
scene on another computer, then load its review. The scene is for the viewer;
the review is the file to paste into a prompt. Native object UUIDs, component
references, CopperScript paths, and net names are retained in both.

## Assembly tracking

**Assembly** (A) tracks a manual build of the open board, part by part. It works
from the board export alone (parts grouped by value and footprint), but is meant
to be used with the project's `assembly.lock`, which adds manufacturer, MPN,
supplier and how each part reaches the board: fitted by hand, by the assembler
(inspect only) or not fitted (confirm the footprint is empty). Values come from
the board.

- With `--project` (or **Open → Project folder…**), the `assembly.lock` beside the
  board source is picked up automatically and read fresh on every reload.
- Otherwise open the board, then `assembly.lock` (**Open → File…**, or drop both).

The lock is read as it is: `copper assembly check` does not run in the browser,
so unreviewed selections are listed but selections out of date with the source
are not detected. For a checked input, CopperScript writes the same content as a
sheet that is only produced when the check passes, and it opens the same way:

```sh
copper assembly bom board.copper --locked --offline --lock assembly.lock -o build/bom.csv \
    --assembly-sheet build/assembly-sheet.json
```

A lock and the sheet written from it name each part the same way, so either can
replace the other without losing progress; a sheet you open is not replaced by the
project's lock. Parts match the board by CopperScript path, then designator; parts
missing from the board and board footprints missing from the lock are listed under
**Assembly details & limits**. Try it with `examples/demo.kicad_pcb` and
`examples/demo.assembly.lock` (or `examples/demo.assembly-sheet.json`).

The plan lists one line per identical part on one side, in passes: SMD on the
side with fewer hand-placed parts first, then the other side, then through-hole,
then assembler-fitted and not-fitted parts. Within a pass, small bodies come
first. Only the side being assembled is drawn (the current line's side; through-hole
parts go in from their own side), with through-hole pads and drills still shown.
The current line's parts are outlined with pin 1 (the pad numbered 1 or A1) ringed.

The **Realistic** look (V, on by default here) draws that side as the board
looks: solder mask over raised copper, exposed pads, white silkscreen and grey
paste on every stencil aperture. Fitted parts get solder on their pads and a body
with a shadow (the fabrication outline, else the span of the pads). It is a
picture, not a check: mask expansion, paste reduction and body heights are not
modelled, and a back side is shown as seen through the board, not mirrored. Switch
it off for the plain view, where placed parts turn green and copper is dimmed.
When zoomed in, a **minimap** in the corner shows the whole side, the current
line's parts and where the view is; click or drag in it to move the view.

- **Space** marks the line placed and moves to the next open line, **I** marks it
  inspected, **J/K** or the arrows step (a line elsewhere on the board is brought
  into view), **Z** zooms to its parts, **F** fits the board.
- **N** / **Shift+N** step through the parts of the current line, panning to each,
  since identical parts can be spread over the board. **X** marks the selected part
  and moves to the next open one.
- Click a part on the board or in the list to set its own status, flag it
  **Needs rework** (P) and add a note; **Add as layout note** carries the note
  into the layout review. Double-click toggles a single part.
- Progress saves in this browser per board file. **Export → Assembly progress**
  writes `<board>.assembly.json` (`copper-review-assembly/v1`) with the sheet,
  to continue on another device; it only opens with the same board file. A part's
  progress is kept only while its sheet selection digest, MPN and footprint are
  unchanged, so a changed selection starts again and is listed.

Ticks record what was done at the bench. They do not verify placement,
orientation or solder joints, and nothing proves the board was built from the
sheet's source.

## Mechanical review and constraint feedback

Inspect the exported board outline, cutouts, footprint geometry, drills and
keepouts alongside placed components and copper. Use a **Mechanical** annotation
to record connector placement, mounting clearance or other visible fit concerns;
select the affected component or region so the feedback keeps its exact board
identity and geometry.

Geometry and constraint authoring belong in CopperScript's
[mechanical/floorplan editor](https://github.com/andenore/CopperScript/blob/main/docs/mechanical-editor.md).
There you can preview placement and review source changes for board geometry,
poses and supported constraints. CopperReview supplies observations for that next
iteration; it does not edit `.copper` intent, enforce solver constraints or verify
3D enclosure clearance. Features absent from the PCB export cannot be recovered
from the drawing alone.

## 3D view

The **3D** button draws a body for every component (drag orbits, shift or
right-drag pans, wheel zooms). Where each body comes from, in order:

1. `copper-review BOARD.kicad_pcb` serves the `*.3dshapes/*.wrl` files beside the
   board. A CopperScript export writes one per footprint into
   `CopperScript.3dshapes/`, the same files KiCad shows.
2. Otherwise the viewer asks CopperScript's WASM build (`generate_body`) to
   generate the body from the footprint geometry the scene carries
   (`body_input`: pads, fabrication and courtyard outline, height). This works
   in the hosted viewer and for boards opened from a file or exported scene.

Bodies from step 2 are approximate and counted as such in the status line. The
viewer never rebuilds bodies itself; the compiler's generator is the only one.

KiCad's own models (a CopperScript export copies them into `CopperScript.3dshapes/`
as STEP) are drawn with [occt-import-js](https://github.com/kovacsv/occt-import-js),
OpenCascade compiled to WASM. It is licensed LGPL-2.1, is about 8 MB, and is
fetched at build time with `npm run build:occt` (pinned by npm's integrity hash,
never committed, loaded only when a STEP model is shown; the licence files are
kept beside it in `copper_review/web/occt/`). Without it the generated body
stands in and the status line says why.

Limits: only VRML and STEP files from `.3dshapes` folders next to the board are
read, so STEP models need `copper-review BOARD.kicad_pcb` (the hosted viewer has no
board folder and shows the generated body); the board is its
bounding rectangle at an assumed 1.6 mm; back-side parts and non-zero model
rotation or offset are placed best-effort and have not been compared with KiCad.
Scenes exported before `body_input` existed, and boards compiled from `.copper`
source in the browser, carry no footprint geometry and show no 3D bodies. The
pinned WASM build must include `generate_body`; an older one reports that it
cannot generate bodies.

## Viewing and storage

- Wheel: zoom under the pointer. Right/middle-drag: pan. **Fit board**: overview.
- Keyboard: C component, N net, R region, F fit, V realistic look, Escape clear (outside form fields).
- **Realistic** draws the visible side as the board looks (mask, silkscreen, metal pads and
  fitted bodies); the choice is remembered per mode. The minimap appears when zoomed in.
- Pads keep their paste and mask layers (`paste_layers`, `mask_layers`, per side). Scenes
  exported before these fields existed assume paste on every outer SMD pad.
- Reference labels never overlap: selected parts and larger bodies win, and the
  status bar counts labels waiting for more zoom.
- Toggle copper layers, reference labels, logical net guides, fills/zone intent,
  or isolate selected nets. Hidden layers remain in explicitly selected net
  snapshots; region queries use the visible layers recorded with the note.
- Pad labels show the number and native pin name, falling back to the net name
  when the PCB has no `pinfunction` field. Labels appear as you zoom in or focus
  a component/net; pad hover always shows the full identity. Toggle them with
  **Pad numbers / names**. Label text stays upright even on rotated pads.
- Hover a pad, track, via, copper fill, or net in the explorer to highlight that
  net's visible pads, tracks, vias, and fills without changing your selection.
- Notes auto-save in browser local storage under the exact board hash. The same
  local port/browser profile is needed to reuse that storage. Export JSON for
  durable storage and sharing; local storage may be unavailable or reach quota.
- All parsing and rendering happens locally. The server binds only to
  `127.0.0.1`, requires a session token for API calls, rejects cross-origin
  requests, and exposes only its own web assets. Files are never uploaded to an
  external service. The UI importer has a 49 MiB input limit; CLI limit is 50 MiB.

## Geometry and limits

Supported: front/back footprints and their local graphics; circular, oval,
rectangular and rounded pads; through/NPTH drills; straight and modern arc
tracks; through/blind/buried via layer spans; polygon/line/arc/circle outlines and
cutouts; board and footprint zones (stored in board coordinates) as intent,
keepouts and stored filled polygons; footprints with blank or repeated references
(named `<reference or footprint>#n`, original kept as `native_reference`);
and filled netted graphic copper exported by CopperScript. Curves are sampled
with at most 0.01 mm chord error. Stored polygons are rendered as stored, including
linked hole contours. Region intersections conservatively use pad bounding
polygons and stroke-expanded boxes, so boundary hits can include nearby objects.
Filled areas use even/odd hole rendering and are not outlined: the retraced
connectors used to store hole contours are not physical edges or tracks.

There is no DRC or connectivity solver. Logical net guides display membership,
including already connected pads; they are not a verified ratsnest or open-net
count. Fully routed is a reviewer declaration. Copper fills are not recomputed.
Non-copper text labels/dimensions are omitted, and 3D models are only drawn in the 3D view (see
[3D view](#3d-view)); custom/trapezoidal
pads use bounding rectangles with visible import warnings. Legacy arc syntax
is rejected; Bezier graphics are reported as unsupported. The importer targets
modern CopperScript exports, not every possible KiCad construct. Electrical-only
`board.json` opens in electrical review when it is a compiled CopperScript board
IR; it supplies no PCB geometry. `.copper` source files must be compiled externally.

## Development

```powershell
python -m unittest discover -s tests -v
node --test tests/core.test.js tests/electrical.test.js tests/topology.test.js tests/compiler.test.js
```

Browser integration test (optional Playwright installation, not a runtime
dependency): start the demo server, then:

```powershell
node tests/browser.mjs "http://127.0.0.1:PORT/#token=TOKEN"
```

`COPPER_PLAYWRIGHT_MODULE` can point to an existing Playwright package;
`COPPER_BROWSER_EXECUTABLE` can point to an installed Chrome/Chromium executable.
The test verifies component/net/region annotations, geometry exports, edit/delete,
review import, persistence, layer controls, and search. Artifacts go to ignored
`test-results/`.
`node tests/assembly-browser.mjs URL` checks assembly mode: planning with and without
the demo sheet, marking, rework notes, persistence, progress export and import.
`node tests/viewer-regressions.mjs "http://127.0.0.1:PORT/#token=TOKEN"` additionally
checks linked-fill holes/connector pixels, pad labels, and transient whole-net hover;
`node tests/issues-labels.mjs URL` checks issue loading/citation and label thinning.
`tests/fixtures/kicad-conformance` is a KiCad 9 board with hand-derived expectations
shared with CopperScript's KiCad reader (keep both copies identical).

The project uses Python's standard library, buildless ES modules, and Canvas 2D.
`copper_review/importer.py` is the file-to-scene adapter; `web/core.js` owns the
geometry query and review contract; `web/app.js` owns interactions and rendering.
