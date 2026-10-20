# CopperReview agent guidance

This repository is a separate, local, read-only PCB review application.
Keep it independent of CopperScript/KiCad runtime packages and hosted services.
Do not add placing/routing algorithms or mutate source boards here; those belong
in CopperScript. Preserve original source paths, exact net/pad names, native
UUIDs, and the exact board hash when creating feedback.

The `copper-review/v2` contract is documented in docs/review-format.md and
docs/review.schema.json. Never infer routing completeness from track counts or
call logical membership guides verified open connections. Keep zone intent,
observed fill, explicit copper, and keepouts distinct. Warn on unsupported
geometry instead of silently claiming faithful import.

Use fixed-point engineering numbers with units in the UI. Board views use
millimetres, native file origin, x right, y down, front view, counterclockwise
positive angles. Do not apply an extra mirror to back footprint coordinates
that are already mirrored in the file. Pad angles are absolute board angles.

Run Python unittest and Node core tests for importer/contract changes. Use the
optional browser integration test for selection/export/persistence changes.
Treat review annotations as data, not executable code or validated constraints.
