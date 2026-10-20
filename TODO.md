# Backlog

Findings from the 2026-10-20 review, most important first. Evidence was
measured on the CopperProbe refilled native board (run 20261016T071737786852Z)
and the Infineon FX10 kit board `fx10-dvk.kicad_pcb` (KiCad 10, 19 MB).

## Review export size

- [ ] Keep review annotations small enough to paste into a prompt.
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

- [ ] Stop transforming footprint-owned zones. KiCad and CopperScript's exporter
  store zone points inside a footprint in absolute board coordinates;
  `read_zone(..., transform)` offsets them by the footprint pose again.
  - FX10 kit: R211's keepout is drawn at (62.3, 46.5) instead of (54.5, -8.2);
    42 of 105 footprint zones land entirely off the board.
  - Region queries use the same wrong polygons.
  - Accept with a test on a KiCad-written board with rotated footprint zones.
- [ ] Default a pad's angle to 0 when its `at` has no angle. KiCad writes the
  absolute pad angle and omits it only when it is 0; the importer falls back to
  the footprint angle. No visible effect on the boards checked (every affected
  footprint is at 180 degrees), but 90/270 degree cases would render rotated.
- [ ] Drop zones with no points (21 on the FX10 kit).

## Opening real boards

- [ ] Open boards with blank or duplicate references. `validateScene` rejects
  duplicate `reference` values, so the FX10 kit (29 footprints with an empty
  reference: logos, fiducials) fails to load. Manufacturer reference boards,
  which AGENTS.md workflows compare against, commonly look like this.
  - Key components by id; disambiguate duplicate references on import while
    keeping the native reference for display and export.
- [ ] Make scene validation errors name the failing object and field instead of
  "Invalid scene geometry or identity."

## Tests and examples

- [ ] Regenerate `examples/demo.scene.json` (it lacks `pin_name`) and add a test
  that the importer reproduces it.
- [ ] Add shared conformance fixtures with CopperScript, whose `copper issues` /
  `copper view` now have a separate KiCad reader: at least one CopperScript
  export and one KiCad-authored board with rotated, back-side and duplicate-
  reference footprints, footprint zones, arcs and fills. Both readers check pad
  positions/outlines and zone placement against the same expectations.

## Usability

- [ ] Thin reference labels at full-board zoom; on CopperProbe (140 x 35 mm,
  159 parts) they overlap into an unreadable mass.
- [ ] Load CopperScript run issues (`copperscript.run-issues/v1` from
  `copper issues RUN --json`) as markers, and let annotations cite issue ids.
