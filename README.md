# CopperReview

A local PCB review tool for CopperScript. Inspect placed, partially routed, or
fully routed board exports; select components, nets, and rectangular regions;
annotate the geometry; export a file for the next LLM-assisted solver iteration.

This is a **separate Git project**, with no runtime dependency on CopperScript,
KiCad, npm, a web service, or a database. Python 3.11+ and a modern browser are
enough. It reads `.kicad_pcb` files directly; KiCad does not need to be installed.
The board is read-only. Feedback never edits the PCB or solver constraints.

## Run

From this repository:

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
5. Click a saved note to inspect/edit it. Set it to resolved when addressed.
   Add a review summary and **Export review JSON** or **Copy JSON to clipboard**.
6. Paste the file contents into an LLM prompt with the relevant CopperScript
   checkout/source available. For example:

   > Use this CopperReview feedback to plan and implement generic placement and
   > routing improvements in CopperScript. Verify the board/source hashes before
   > reproducing the findings. Treat the notes as observations and desired
   > behavior. Build a small reproducer, preserve existing placement/macro intent,
   > and test the algorithm rather than adding a board-specific repair.

Review files are saved as `<board>.review.json`, schema `copper-review/v1`.
See [the output contract](docs/review-format.md), [JSON Schema](docs/review.schema.json),
and [the complete example review](examples/demo.review.json).

Use **Load review** to resume notes after opening the exact matching PCB.
Reviews for a different board hash are rejected. **Save scene** writes a
portable `<board>.scene.json`, containing the normalized geometry. Open that
scene on another computer, then load its review. The scene is for the viewer;
the review is the file to paste into a prompt. Native object UUIDs, component
references, CopperScript paths, and net names are retained in both.

## Viewing and storage

- Wheel: zoom under the pointer. Right/middle-drag: pan. **Fit board**: overview.
- Keyboard: C component, N net, R region, F fit, Escape clear (outside form fields).
- Toggle copper layers, reference labels, logical net guides, fills/zone intent,
  or isolate selected nets. Hidden layers remain in explicitly selected net
  snapshots; region queries use the visible layers recorded with the note.
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
cutouts; board and footprint-local zone intent/keepouts; stored filled polygons;
and filled netted graphic copper exported by CopperScript. Curves are sampled
with at most 0.01 mm chord error. Stored polygons are rendered as stored, including
linked hole contours. Region intersections conservatively use pad bounding
polygons and stroke-expanded boxes, so boundary hits can include nearby objects.

There is no DRC or connectivity solver. Logical net guides display membership,
including already connected pads; they are not a verified ratsnest or open-net
count. Fully routed is a reviewer declaration. Copper fills are not recomputed.
Non-copper text labels/dimensions and 3D models are omitted; custom/trapezoidal
pads use bounding rectangles with visible import warnings. Legacy arc syntax
is rejected; Bezier graphics are reported as unsupported. The importer targets
modern CopperScript exports, not every possible KiCad construct. Electrical-only
`board.json` and `.copper` files do not contain the placed geometry required by
this viewer; export a PCB or scene first.

## Development

```powershell
python -m unittest discover -s tests -v
node --test tests/core.test.js
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

The project uses Python's standard library, buildless ES modules, and Canvas 2D.
`copper_review/importer.py` is the file-to-scene adapter; `web/core.js` owns the
geometry query and review contract; `web/app.js` owns interactions and rendering.
