# Electrical review

CopperReview reads `copperscript-ir/v0.1` board JSON produced by the public
`copper compile` command. It requires no CopperScript installation at runtime.
Use **Open electrical IR**, pass a JSON file as the CLI input, or run:

```console
copper compile board.copper --locked --offline -o electrical.ir.json
python -m copper_review --electrical-ir electrical.ir.json
```

Public GitHub source projects can also be opened through **Open URL**; browser
dependency resolution reuses CopperScript WASM and verifies pinned source files.
See [source snapshots and limits](wasm-hosting.md#open-from-url).

No PCB or placement data is needed. PCB geometry review remains available with
its original annotations and `copper-review/v2` contract. Use **PCB review** and
**Electrical review** to switch between loaded documents. Their input identities
are independent; the application does not assert that a PCB matches an IR.

## Linked views

- **Schematic** (the default) draws generated sheets from the IR; it is not an
  authored drawing. Module scopes, then signal connectivity, split the board: a
  part with more than 20 signal nets gets its own sheet with the headers and small
  parts that only reach it, other clusters hold at most 36 parts. Columns follow
  output-to-input direction, including through series two-pin parts. Power and
  ground pins become rail flags and ground symbols (one per net, marked ×n);
  declared supplies decide a net's role, and pins claiming both power and ground
  (generic headers) are ignored. Decoupling/support passives fold into `C×n`
  badges on the rail flag of the pin they decouple; plain pull resistors of at
  least 1 kΩ fold into ↑/↓ notes (`↑4.7k`). Series links between two plain signal
  nets (0 Ω jumpers, damping resistors above 1 Ω up to 100 Ω, signal-path inductors
  and beads) fold into a `⟷33Ω` note on the far side, and the two nets are drawn as
  one under the first name; pin tooltips keep the pin's own net. `protection.*`
  parts that clamp signals to rails fold into an `ESD` note on each signal. Current
  shunts (≤ 1 Ω, or a `shunt`/`sense` role), termination, divider and filter parts
  stay drawn. Each sheet lists its folded parts and **Show passives** draws them all.
  Values use short schematic forms (`4.7k`, `100nF`). A net is a wire only where every pin faces the same column gap, so wires
  never cross a symbol; other connections use labels, with ↗ when the net continues
  on another sheet. An interface (declared interface or configured peripheral) whose
  nets all run as wires between the same parts, on adjacent pins, is drawn as one
  thick bus line labelled with its name and net count; selecting it, or one of its
  nets or pins, draws the nets separately. Selecting anything fades what is not on
  its signal nets (**Fade unrelated** turns this off); rails only count when selected
  directly, and clicking empty drawing space clears the selection. Unconnected-pin
  counts show only on the selected part. Explorer and focus-picker choices open the
  sheet that shows them.
- **Focused schematic** draws a pin-labelled slice with one symbol per component.
  It starts at a configured peripheral when present. The focus picker includes
  interfaces, components and rails. Explorer items and interface titles focus in
  one action; **Back** returns to the previous circuit. Selecting
  a wire or pin inspects it without rearranging the current slice. Large slices
  use the complete net-by-net terminal view; it remains expandable under smaller
  drawings. Supplies and decoupling properties are in **Component pins, supplies
  & support**. These are generic symbols, not manufacturer schematic artwork.
  Supporting passives (explicit decoupling or passives connected only to supply/
  ground nets) are collapsed by default. Signal-path resistors and other passive
  circuits remain visible. Collapsed groups show their count; expand them or use
  **Show passives** to see every component. Explicitly focusing a passive retains it.
- **Power hierarchy** opens with a simple **Topology** diagram. Red lines represent
  actual shared power nets between source/regulator/switch boxes and receiving ICs
  or connectors. Rail names, voltages, enable connections and declared states are
  labelled; passive loads appear as counts unless **Show passives** is enabled.
  All rails share one connected figure, with one box per exact device instance.
  A device receiving both main power and backup power has both rail connections
  on the same box. Rail junctions are distinct from device boxes; crossings do not
  imply connectivity. Select boxes or supply lines to inspect
  their pins and intent. Loads are grouped around a drawing tree of their main
  supply inputs; backup and additional supply edges remain explicitly connected.
  Wires avoid device boxes, and shared rail branches use a common trunk. Distinct
  rails never share a line segment; a gap distinguishes any remaining crossover
  from a junction dot. Drawing paths are cached so selection does not rearrange
  them. This is presentation geometry, not PCB placement/routing or a new power
  dependency check. **Connections** opens the detailed hierarchy, which
  groups declared supplies and power-output pins with their
  connected loads. Source IC power-input and bidirectional power pins suggest
  parent rails. Shared and cyclic dependencies remain visible. Enable/control
  candidates are explicitly labelled as pin-name inferences. Additional power-pin
  nets of unspecified role are listed separately. Only explicit power-state
  assignments produce on/off labels: absent values stay **unspecified**.
- **Buses & interfaces** opens with the same simplified **Topology** presentation:
  one device box per instance, linked through shared signal junctions. Equivalent
  declarations of the same connected signals are combined; separate interfaces
  between the same devices remain separate. Translators and filters occur once
  with connections on both sides. Branching interfaces preserve shared membership.
  Buses display their logical names and protocol labels, with a color legend for
  the types present. Protocols come from declared interface types or configured
  peripheral identifiers, never signal-name guesses. Aliases and original type/
  peripheral identifiers remain in labels or tooltips. A drawing tree groups
  nearby branches, with separate fan-out channels around busy ICs. Paths avoid
  device boxes; unrelated buses never share a line segment. Translator/filter
  sides use separate drawing bundles even when they select the same interface.
  Junction dots and crossover gaps have the same meaning as in the power view.
  Selection preserves cached paths and remains linked to the inspector and intent.
  Selecting junctions opens the original interface in the inspector. **Connections**
  retains the detailed interface list. The topology shows declared interfaces and configured peripherals.
  Paths may expand through translator/filter/choke signal pins to expose remote
  ICs and connectors; this does not establish internal channel correspondence.
  Other connected signal nets are listed as **Unclassified signal**, without
  inventing UART, SPI, USB or other protocol declarations.
  They are folded under **other signal nets**, rather than mixed into the interface
  overview. Passive support components and power-rail passive loads have their own
  counted disclosures; the full IR and source excerpts remain unchanged.

One selection drives the side panel across all views. Its top shows the selection
with exact instance paths, net aliases, pin names/numbers, available ratings,
unpowered behavior and all pins without a net. **Details** shows declared
supplies, interfaces, component properties and library document references.
The review limits (connectivity and ratings come from the IR; purpose, protocol
grouping, power sequencing and device behavior are not validated) are stated once
in the line under the canvas. Drawing elements carry hover tooltips.
**Source** is a resolved IR excerpt, not recovered `.copper` text. Original
comments or requirements absent from the IR cannot be reconstructed.

On desktop the explorer, canvas and inspector/intent panes have bounded scroll
areas. Large schematics can scroll horizontally and vertically at readable size;
**Fit view** fits the drawing and **100%** restores its natural size. In the Schematic view the
wheel zooms under the pointer and right- or middle-drag pans. **Maximize** hides the page
header and side panels to give the drawing the whole window (Esc restores), and
Fit view there may enlarge a small sheet. Power, bus and
focused schematic zoom settings are independent. On narrow
screens the page stacks and the canvas keeps its own scroll area. Passive visibility
is remembered with the review. Searching the explorer includes collapsed passives.

### Notes

On the Schematic, double-click an element or press **N** to write a note about the
selection in a small editor next to it: category and priority chips, the
observation, and an optional desired behavior (Ctrl+Enter saves, Esc cancels).
Saved notes appear as numbered markers where their entity is drawn (red for high
priority, grey once resolved); click one to edit, resolve or reopen it. The sheet
list shows `✎ n` for sheets with notes. **Notes** lists every note and has the same
editor for the other views (N opens it there).

## Input and feedback identity

The server wraps the original IR in `copper-review-electrical/v1` with `input`
containing its filename and SHA-256 of the exact original bytes, and `ir` containing
the parsed document. BOMs, CRLF and whitespace therefore affect identity. The hash
identifies the compiled input file; it does not independently prove source or
dependency freshness. Module instances expand recursively and module ports merge
connected nets. Private nets remain scoped and exported aliases are retained.
Missing endpoints produce explicit warnings; unsupported schemas, missing part or
module definitions and recursive modules fail rather than fabricating connectivity.

Electrical notes use a separate `copper-electrical-review/v1` contract:

```json
{
  "schema": "copper-electrical-review/v1",
  "input": {"filename": "electrical.ir.json", "sha256": "<64 lowercase hex characters>"},
  "selection": {"kind": "pin", "id": "PWR/U_MODEM.EN"},
  "view": "power",
  "power_state": "LOGIC_ONLY",
  "annotations": []
}
```

Each annotation contains an `id`, `selection`, `view`, `power_state`, `category`,
`priority`, `status`, `observation`, `desired_behavior`, `created_at` and
`updated_at`. As in PCB reviews, `observation` is the perceived problem and
`desired_behavior` the requested outcome; priority is `low`, `medium` or `high` and
status `open` or `resolved`. Categories are `connectivity`, `power`, `interface`,
`part_choice`, `protection` and `other`. Notes written before these fields existed
load as `other`, `medium`, `open`. Selection kinds are `component`,
`pin`, `net` and `bus`; IDs retain exact resolved instance/net identities. Bus IDs
are prefixed `interface:`, `peripheral:` or `net:`. Loading requires the exact input
hash and existing selected entities. Notes, view, selection, focus and chosen state
save locally per IR hash. Export JSON for durable sharing. PCB reviews are never
silently converted into electrical reviews.

## Validation

```console
python -m unittest discover -s tests -v
node --test tests/core.test.js tests/electrical.test.js tests/topology.test.js
node tests/electrical-browser.mjs http://127.0.0.1:PORT/#token=TOKEN [path/to/fresh/board.ir.json]
node tests/electrical-usability.mjs http://127.0.0.1:PORT/#token=TOKEN [path/to/fresh/board.ir.json]
node tests/power-topology.mjs http://127.0.0.1:PORT/#token=TOKEN [path/to/fresh/board.ir.json]
node tests/connected-graphs.mjs http://127.0.0.1:PORT/#token=TOKEN [path/to/fresh/board.ir.json]
```

The optional browser test imports the synthetic hierarchical fixture and checks
linked selection, independent backup rail state, source identities, notes,
export/import, storage, revision mismatch, text escaping, PCB coexistence and
mobile layout. The optional final IR argument produces screenshots of a real
design in `test-results/`. Existing PCB browser tests remain applicable.

This is electrical inspection, not ERC, simulation, power sequencing analysis,
verification of internal device connectivity or qualification. Voltage annotations
are nominal; missing or conditional ratings are not turned into guarantees.
