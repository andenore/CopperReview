# CopperReview

[Open CopperReview on GitHub Pages](https://andenore.github.io/CopperReview/).

A local electrical and PCB review tool for CopperScript. Inspect placed, partially routed, or
fully routed board exports; select components, nets, and rectangular regions;
annotate the geometry; export a file for the next LLM-assisted solver iteration.

This is a **separate Git project**. Its static browser build reuses CopperScript's
Rust compiler, ERC and queries through a bundled WebAssembly worker. No native
CopperScript installation or hosted backend is required by that build. The local
Python 3.11+ server additionally reads raw `.kicad_pcb` files without KiCad.
See [WASM build, static hosting and current boundaries](docs/wasm-hosting.md).
For schematic, power hierarchy and bus/interface review before layout, open the
JSON produced by `copper compile` with **Open electrical IR**, or run
`python -m copper_review --electrical-ir electrical.ir.json`. It opens on a generated
**Schematic**; all three electrical views share one side panel (selection, details, source, notes). On the
Schematic, double-click or press N to note the selection; notes show as numbered markers. See the
[electrical workflow and input/feedback contracts](docs/electrical-review.md).
**Open folder** compiles a local project folder (the one holding `board.copper` and
`copper.mod`) in the browser with the same compiler: its sources never leave the
computer, and only dependencies pinned in `copper.lock` are downloaded from GitHub
and checked against the lock. A folder with several boards asks which to compile.
Re-pick the folder after editing to recompile.
**Compile .copper** and **Try example circuit** use the actual WASM compiler for
self-contained source. **Open URL** compiles GitHub source projects with
local imports and pinned library dependencies through the same Rust compiler.
**Open URL** accepts GitHub repository/file links or direct HTTPS design files.
Private repositories need a fine-grained token with Contents: Read-only under
**Private repository access**; it stays in the tab and is sent only to `api.github.com`. Choose the board source at its resolved commit; the browser reads
`copper.mod` / `copper.lock`, verifies imported source bytes and opens the electrical
review. CopperAssetTracker can be opened directly from its GitHub `board.copper`.
Exported IR and PCB scene files remain supported.
See [URL loading and provenance](docs/wasm-hosting.md#open-from-url).
The board is read-only. Feedback never edits the PCB or solver constraints.

## Run

On Ubuntu (or anywhere with `make`, [uv](https://docs.astral.sh/uv/) and Node.js 20+):

```bash
make setup                                   # check tools, install, fetch the browser compiler
make serve PROJECT=../BysseControl-32        # compile a project folder; reload to recompile
make serve PROJECT=../BysseControl-32 HOST=0.0.0.0 OPEN=no   # reachable from other machines
make serve IR=build/electrical.ir.json       # or a compiled IR; BOARD=… for a PCB
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

The server lists and serves only the folder's `.copper` sources and
`copper.mod` / `copper.lock` (skipping `.git`, `.copper-cache`, `node_modules`,
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
   `copper issues RUN --json > issues.json` and click **Load issues**. Issue
   windows are drawn on the board and listed in the **Issues** tab; clicking one
   frames it, selects its window as a region and fills **Cites CopperScript
   issues**. The list is rejected when its board hash differs from the open board.
5. Click a saved note to inspect/edit it. Set it to resolved when addressed.
   Add a review summary and **Export review JSON** or **Copy JSON to clipboard**.
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

Use **Load review** to resume notes after opening the exact matching PCB.
Reviews for a different board hash are rejected. **Save scene** writes a
portable `<board>.scene.json`, containing the normalized geometry. Open that
scene on another computer, then load its review. The scene is for the viewer;
the review is the file to paste into a prompt. Native object UUIDs, component
references, CopperScript paths, and net names are retained in both.

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

## Viewing and storage

- Wheel: zoom under the pointer. Right/middle-drag: pan. **Fit board**: overview.
- Keyboard: C component, N net, R region, F fit, Escape clear (outside form fields).
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
Non-copper text labels/dimensions and 3D models are omitted; custom/trapezoidal
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
`node tests/viewer-regressions.mjs "http://127.0.0.1:PORT/#token=TOKEN"` additionally
checks linked-fill holes/connector pixels, pad labels, and transient whole-net hover;
`node tests/issues-labels.mjs URL` checks issue loading/citation and label thinning.
`tests/fixtures/kicad-conformance` is a KiCad 9 board with hand-derived expectations
shared with CopperScript's KiCad reader (keep both copies identical).

The project uses Python's standard library, buildless ES modules, and Canvas 2D.
`copper_review/importer.py` is the file-to-scene adapter; `web/core.js` owns the
geometry query and review contract; `web/app.js` owns interactions and rendering.
