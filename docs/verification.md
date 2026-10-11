# Verification — 11 October 2026

- 12 Python tests passed: parsing, original-byte identity, rotated/front/back
  pad geometry, multilayer via spans, circular arcs, explicit copper polygons,
  local keepouts, declared stage, and loopback server access/import behavior.
- 8 Node tests passed: fixed-point engineering labels, region intersections,
  layered geometry, selected-net/component snapshots, review round trips,
  revision mismatch rejection, and scene validation.
- Browser integration passed in installed Chrome: canvas pad hit-testing,
  component/net/rectangular selections, annotation add/edit/delete, JSON
  download/reload, local persistence, layer switches, logical guides, and search.
- Real-board browser import/render/selection/export passed on the Tracker's
  six-layer `finished-routed.kicad_pcb`: 83 components, 73 nets, 854 track segments,
  295 vias. Its exported SHA-256 matched the original file bytes.
- Read-only importer checks also passed on the Tracker's placed board,
  CopperScript's routed CM4 baseboard, and the circular LED-ring ground-check
  board, including stored copper-fill polygons.
- An installable Python wheel built successfully with all four web assets and
  the `copper-review` entry point. The example review contains the published
  JSON Schema's required fields; full external JSON Schema validation was not run.

These checks validate review-tool behavior and geometry extraction. They do not
qualify the reviewed boards or establish electrical connectivity/DRC compliance.
No input boards or CopperScript sources were modified by these checks.

## Viewer fixes

- Stored-fill contours now render filled areas and holes without stroking the
  retraced connectors between contours. A pixel regression verifies that a long
  horizontal connector matches the adjacent filled area and the hole stays empty.
- Pad labels use the native pin name when available and the net name otherwise;
  pad numbers remain visible, names stay upright, and labels can be toggled.
- Net hover highlights every matching visible pad, track, via and fill in all
  selection modes, and also works from the net explorer. Hover is transient,
  preserves the annotation selection, and respects visible-layer filters.
- 13 Python tests, 9 Node tests, the existing browser workflow, the viewer pixel
  regression, and the real six-layer Tracker board browser check passed.

## Track joints

- Tracks on each net/layer are rendered as one filled copper union, applying
  opacity once across bends, branches, width changes and crossings. Physical
  round-ended track geometry is preserved without overlapping stroke seams.
- The geometry is cached per scene; canonical segment directions and duplicate
  removal keep edge rendering stable for reversed/repeated source segments.
- `tests/track-joints.mjs` passed pixel checks at device pixel ratios 1 and 2:
  uniform interior colour, identical full-canvas raster for reordered/reversed
  duplicates, zero-length segments, hover/dimming, zoom/pan and layer filtering.
- The 9 Node tests, annotation browser workflow, fill/label/hover regression,
  and real six-layer Tracker board browser check also passed after this change.
