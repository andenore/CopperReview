# CopperScript WebAssembly and static hosting

CopperReview reuses the existing CopperScript `copper-web` crate. Its `review`
export runs the native parser/compiler, ERC, elaboration and component/pin/net
queries, and returns the CLI serializer's exact electrical IR text. The viewer
does not implement a second compiler or ERC engine. The older playground `analyze`
export is unchanged. Its `review_project` export adds bounded source snapshots
and import discovery through the same package resolver and compiler.

## Build

Use an explicit CopperScript checkout containing `copper-web::review_source`,
`review_project_source`, and their `review` / `review_project` WASM exports. Keep board dependency/compiler pins unchanged.

```console
rustup target add wasm32-unknown-unknown
cargo install --locked wasm-bindgen-cli --version 0.2.130
```

Run the following from CopperReview (set `COPPERSCRIPT_REPO` to the compiler
checkout; the default is a sibling `CopperScript` directory):

```console
npm run build:wasm
npm run test:wasm
npm run build:static
node scripts/serve-static.mjs
```

`WASM_BINDGEN` can name the official prebuilt 0.2.130 bindings tool. The Rust
toolchain comes from the selected CopperScript checkout. Cargo builds with
`--locked`; generated bindings and the WASM binary live in ignored
`copper_review/web/wasm/`. They are not edited by hand. `manifest.json` records the
source revision/modified flag, Cargo.lock digest, bindings version and binary and
bindings hashes. The static build checks those hashes; the worker checks the WASM
hash before instantiation. These identify the build, not a qualified release.

The result in `dist/` is entirely static. The preview intentionally serves it at
`http://127.0.0.1:9390/CopperReview/` to exercise repository-relative asset, worker
and WASM URLs. No `/api/` server or session token is used in static mode.

## Use and limits

- **Compile .copper** opens a source file read-only and runs CopperScript in a
  dedicated browser worker. **Try example circuit** runs the bundled educational
  circuit. Successful compilation opens the ordinary electrical review views.
- Standalone file uploads accept self-contained source up to 512 KiB and the bundled
  demonstration library. Uploading one file provides no filesystem context;
  `WEB_IMPORT` directs imported source to **Open URL** instead. Public GitHub
  projects support local and transitive remote imports with pinned source bytes.
- The worker has a 60-second loading deadline and a 30-second standalone analysis
  deadline. Project analysis gets 60 seconds per pass and 300 seconds overall.
  Cancellation, traps and late results cannot replace a newer design. Failures
  leave the previous design explicitly identified and available for review.
- The compiler panel exposes native ERC findings and component/pin/net query
  results. ERC failures with a compilable design remain reviewable. Syntax/import
  failures return no IR. Existing IR files are displayed without inventing an ERC
  result; no simulation, routing or manufacturing check is implied.
- IR and saved PCB scene JSON load directly with the File API. Their original
  input hashes are preserved. Compiler-created IR records both its IR hash and
  the original source file hash plus compiler build identity.
- The current raw `.kicad_pcb` importer is Python. It remains available in local
  server mode. Hosted mode accepts exported `.scene.json` files and explicitly
  rejects raw PCB input. CopperScript's Rust scene reader omits some identities
  and presentation data needed by CopperReview, so it is not substituted with
  silent loss of pin names, UUIDs or geometry. A shared Rust review-scene export
  with conformance parity is the next reusable boundary for that importer.
- Local files and source remain on the user's device. **Open URL** downloads the
  explicitly requested remote design; workers fetch this site's static compiler
  assets and compile locally. No source is uploaded. Designs resume through IndexedDB;
  notes remain in hash-keyed browser storage and can be exported to JSON. A new
  local server input is not overwritten by an unrelated saved design.

Local Python serving still supports all existing PCB workflows. Build the WASM
assets before using its source compiler button. Packaged distributions include
`web/wasm/*` when those assets have been built.

## Open from URL

Use **Open URL** in the header or empty state. It accepts a public GitHub repository,
folder, blob or raw file URL, or a direct HTTPS file URL on a host permitting browser
downloads (CORS). A repository opens a file chooser; exports are never automatically
selected or asserted to match current source. Discovery includes `.copper`,
`.ir.json`, `.scene.json`, electrical JSON exports and `.kicad_pcb`. Paste a direct
file link for other JSON filenames. Raw PCB files still require local server mode.

The optional ref field selects a branch, tag or commit for repository links. For
GitHub blob/tree/raw links it must match the URL; enter the full branch name here
when it contains `/`. GitHub refs resolve to an immutable commit before listing or
downloading files. The review stores the repository, commit, path and source URL
alongside the existing original-byte hash, and shows the origin in the header.
These identify the downloaded file, not the freshness of an exported artifact.

GitHub `.copper` entries compile as projects. The browser finds the nearest
`copper.mod`, loads `copper.lock`, and supplies a source inventory at the selected
repository commit to the WASM worker. CopperScript's parser and package resolver
request the required files, including nested packages and relative imports inside
library modules. The browser fetches those requests with at most six parallel GETs.
Commit pins download directly; branch/tag requirements resolve to an immutable
commit once per compilation. The Rust adapter and browser both verify each fetched
remote source against its lockfile size and SHA-256. Missing pins, checksum
mismatches, cycles, invalid manifests and escaping relative paths are errors.
No lockfiles are generated or updated. In-workspace local replacements and remote
GitHub replacements follow the native manifest syntax; replacements outside the
downloaded workspace, Git submodules and source symlinks are unsupported.

The native compiler then produces electrical IR, ERC and pin/net queries. The
review records root source, manifest/lock hashes, resolved dependency commits and
every loaded source hash. This is an electrical source snapshot: footprint, 3D,
physical macro data and other assets are not downloaded or verified. The original
lock inventory is checked for consistency, but its unfetched assets are not
asserted to match a local full-module build. Workspace package checksums describe
loaded electrical sources. The UI and exported provenance state that scope.

CopperAssetTracker's GitHub `board.copper` works directly. Existing project compiler
and dependency pins are preserved; the hosted compiler is the bundled WASM build
shown in the compiler panel, rather than an automatically selected `.copper-version`.
Direct HTTPS files without a GitHub repository context remain standalone inputs.

Requests are browser-side GETs without credentials or the local server token.
There is no authentication or proxy service; private repositories, API rate limits,
blocked CORS and incomplete repository trees produce explicit errors. Downloads
are capped at 49 MiB (repository metadata at 8 MiB), with a 20-second request
deadline. Standalone source is bounded at 512 KiB; project sources are limited
to 512 KiB per file, 512 loaded files and 8 MiB total. Snapshot JSON is capped at
24 MiB and dependency expansion at 32 passes. Cancelled or failed loads keep the
previous design. Notes remain bound to exact design hashes.

GitHub integration uses the documented read-only
[repository contents/ref model](https://docs.github.com/en/rest/repos/contents)
and [Git trees API](https://docs.github.com/en/rest/git/trees).

## GitHub Pages

The published viewer is at <https://andenore.github.io/CopperReviewPages/>.
`andenore/CopperReviewPages` contains only the generated static site. CopperReview's
source repository stays private: its current GitHub plan does not support Pages
directly from that private repository. The hosting repository serves `main` at `/`
with `.nojekyll`; no server, GitHub credentials or private project data are bundled.

For updates, build/test this checkout against an exact published CopperScript
commit, run `npm run build:static`, and commit the resulting `dist/` contents to
the hosting repository. Keep its README/build provenance with the deployment.
The initial project-capable compiler commit is
`f260798be5af0a8c5f5cb0d0e5c978160e3abcab` on
`andenore/CopperScript` (`codex/browser-project-review`).

The manual `.github/workflows/pages.yml` builds the selected CopperScript revision,
tests the actual WASM and uploads `dist/` as the Pages artifact. Supply a commit
containing the new review export after the CopperScript change is published.
`publish` defaults to false; enabling it deploys the checked artifact using the
repository's GitHub Pages environment when the source repository plan supports
Pages. Select GitHub Actions as the Pages source in that configuration.
No hosted deployment or remote push is performed by local build commands.

## Validation

```console
npm test
npm run test:wasm
python -m unittest discover -s tests -v
node tests/static-browser.mjs http://127.0.0.1:9390/CopperReview/
node tests/projects-browser.mjs http://127.0.0.1:9390/CopperReview/
node tests/project-dependencies-browser.mjs http://127.0.0.1:9390/CopperReview/
```

The optional Playwright test checks the real WASM worker, native ERC failures,
import rejection, worker-load failure/recovery, project-subpath URLs, zero backend
requests/uploads, direct IR/scene loading, source identity and browser persistence.
Existing electrical, power-topology, connected-graph and PCB browser tests still
apply to the local mode.
URL tests cover pinned ref discovery, original-byte hashes and provenance,
repository choice, real WASM source compilation, scenes, persistence, failed loads,
cancellation, responsive layout and absence of uploads. Network fixtures make the
browser regression independent of GitHub availability and rate limits.

Project tests exercise the actual WASM import planner/compiler with local,
transitive and relative packages, native lock checks, altered bytes, missing pins,
cancellation and exported project identities. A fresh CopperAssetTracker source
compile was compared with its pinned native CLI: 83 component identities, 73 net
identities and all pin memberships matched. Public GitHub loading was also checked;
that read-only check is not a hardware qualification or source release gate.
