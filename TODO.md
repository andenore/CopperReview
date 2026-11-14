# Backlog

All items below were fixed on 2026-10-20; see docs/verification.md for the
measurements. Add new findings as open items.

Findings from the 2026-10-20 review, most important first. Evidence was
measured on the CopperProbe refilled native board (run 20261016T071737786852Z)
and the Infineon FX10 kit board `fx10-dvk.kicad_pcb` (KiCad 10, 19 MB).

## Review export size

- [x] Keep review annotations small enough to paste into a prompt.
  `snapshotSelection` copies complete selected nets (every track, via and fill
  polygon) and `regionContext` copies whole intersecting zone polygons and full
  component objects into each annotation.
  - CopperProbe: one annotation selecting GND is 357 KB (~90k tokens); a
    2 x 2 mm region annotation is 247 KB.
  - FX10 kit: single annotations are 1.2-1.4 MB.
  - Accept when annotations store identities (object ids, references, net
    names, board hash) plus compact summaries (counts, bounds, nearby object
    ids), fills are clipped to the region or cited by id, and a size budget is
    tested on a real filled board. The scene already holds the full geometry.

## Geometry correctness

- [x] Stop transforming footprint-owned zones. KiCad and CopperScript's exporter
  store zone points inside a footprint in absolute board coordinates;
  `read_zone(..., transform)` offsets them by the footprint pose again.
  - FX10 kit: R211's keepout is drawn at (62.3, 46.5) instead of (54.5, -8.2);
    42 of 105 footprint zones land entirely off the board.
  - Region queries use the same wrong polygons.
  - Accept with a test on a KiCad-written board with rotated footprint zones.
- [x] Default a pad's angle to 0 when its `at` has no angle. KiCad writes the
  absolute pad angle and omits it only when it is 0; the importer falls back to
  the footprint angle. No visible effect on the boards checked (every affected
  footprint is at 180 degrees), but 90/270 degree cases would render rotated.
- [x] Drop zones with no points (21 on the FX10 kit).

## Opening real boards

- [x] Open boards with blank or duplicate references. `validateScene` rejects
  duplicate `reference` values, so the FX10 kit (29 footprints with an empty
  reference: logos, fiducials) fails to load. Manufacturer reference boards,
  which AGENTS.md workflows compare against, commonly look like this.
  - Key components by id; disambiguate duplicate references on import while
    keeping the native reference for display and export.
- [x] Make scene validation errors name the failing object and field instead of
  "Invalid scene geometry or identity."

## Tests and examples

- [x] Regenerate `examples/demo.scene.json` (it lacks `pin_name`) and add a test
  that the importer reproduces it.
- [x] Add shared conformance fixtures with CopperScript, whose `copper issues` /
  `copper view` now have a separate KiCad reader: at least one CopperScript
  export and one KiCad-authored board with rotated, back-side and duplicate-
  reference footprints, footprint zones, arcs and fills. Both readers check pad
  positions/outlines and zone placement against the same expectations.

## Usability

- [x] Thin reference labels at full-board zoom; on CopperProbe (140 x 35 mm,
  159 parts) they overlap into an unreadable mass.
- [x] Load CopperScript run issues (`copperscript.run-issues/v1` from
  `copper issues RUN --json`) as markers, and let annotations cite issue ids.

## Open items

- EMI layer (docs/emi-review.md): `tests/emi-browser.mjs` is written but was not run where it was
  made (no Playwright installed); the same steps were driven with headless Chrome over the DevTools
  protocol. `docs/review.schema.json` gained the EMI fields, but `jsonschema` was not installed there,
  so `examples/emi-buck.review.json` is checked by the Node tests, not against the schema.
- EMI layer: the report records no board hash, so a report can only be matched to a board by the
  part references it names. Ask CopperScript to write the board's SHA-256 into the `emi` section.
- EMI layer: a proximity finding stores no pad positions (only a message naming the pads), so the
  victim line is found by searching the board for the closest source and victim pads; the report's own
  distance may be measured differently. A stored pad pair would make the line exact.
- EMI layer: no z-to-layer table, so a dashed hot-loop leg cannot be named by layer or hidden with it.
