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
