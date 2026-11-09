# Ask about the design

Select something in CopperReview and ask your connected agent **“What does this
do?”** in the chat you already use. The viewer supplies shared visual context;
the answer stays in that chat. No `wait_for_question` loop is needed for this path.

The agent's main job is to help the reviewer understand the board: explain a
part, identify its connections, trace declared power relationships, or interpret
available layout information. Questions do not automatically ask for a fault
audit or a design change. Answers live in a conversation, with evidence and
explicit uncertainty. They never change source, routing or constraints.

## Start and connect once

From this checkout:

```console
uv run copper-review path/to/board.kicad_pcb --agents
```

Click **Connect agent** in the viewer's top bar. Choose your host:

- **ChatGPT desktop / Codex**: copy the generated command and arguments into
  Settings → MCP servers → Add server → STDIO, then save and restart the
  connection. This is the local Codex host flow described in the
  [official OpenAI documentation](https://learn.chatgpt.com/docs/extend/mcp).
  If these settings are absent in your app, use the generated TOML with Codex
  CLI or the IDE extension. This setup does not configure ChatGPT web.
- **Claude Desktop**: download **copper-review.mcpb**, open it with Claude Desktop
  or install it through Settings → Desktop app → Extensions → Advanced settings.
  Keep the prefilled Python executable. The adapter is bundled; it needs the
  Python 3.11+ interpreter already running your viewer, not a separate package
  installation. On another computer, choose that computer's Python executable.
  If a manual CopperReview entry already exists, disable it before installing
  the extension to avoid duplicate connections.
- **Claude Code**: copy the generated setup command and run it in the indicated
  shell. Update an existing `copper-review` entry instead of adding a duplicate.
  On Windows the generated separator is quoted as `'--'` so PowerShell preserves
  it when invoking npm's `claude.ps1` shim.
- **Another MCP host**: use the generated command, argument array and environment
  values. Merge the JSON with existing servers rather than replacing them.

The dialog uses the running Python executable and an absolute launcher path.
There is no dependency on `uv` or a particular working directory in the host.
Keep this CopperReview installation available; regenerate the configuration if
you move it. The downloaded extension includes its own adapter code, so only its
configured Python runtime must remain available. Configurations and bundles
contain no viewer token or board data. A custom `COPPER_REVIEW_REGISTRY` path,
if set, is included so the adapter finds the same registry as the viewer.

**Test connection** generates a short prompt to paste into your chat. The test
passes only after the host fetches this tab's exact context after the test starts.
A heartbeat or a read from another tab does not pass it. It expires after two
minutes; changing selection means starting a new test. This proves context
delivery, not model reasoning or an answer.

The top-bar indicator distinguishes **Connect agent**, **Agent connected**, and
**Selection read**. The dialog identifies the shared design, hash, selection and
tab. Host names come from MCP initialization and are self-reported. A connected
adapter sends a heartbeat every five seconds; after fifteen seconds without
activity the indicator no longer reports it as connected. A live host can still
have no active model turn; sidebar questions may remain queued in that case.

These paths use local desktop hosts. Hosted web chats need a remote MCP transport
or supported tunnel; the viewer's URL is not a remote MCP endpoint. The dialog
links to the host's setup guidance. CopperReview does not create a tunnel or
change host settings automatically.

Host references: [OpenAI desktop MCP setup](https://learn.chatgpt.com/docs/extend/mcp),
[Claude Desktop extensions](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop),
[Claude Code MCP setup](https://code.claude.com/docs/en/mcp).

### Manual setup

Compiled electrical IR and `--project` work with the same option. Configure this
stdio MCP server in your agent host (substitute this checkout's absolute path):

```json
{
  "mcpServers": {
    "copper-review": {
      "command": "uv",
      "args": ["--directory", "C:/path/to/CopperReview", "run", "copper-review-mcp"]
    }
  }
}
```

There is no port or token to copy. The adapter discovers local viewers, can start
before the viewer, and resolves the running viewer on every call. Heartbeats
and ordinary reads never pin a viewer. Only an explicit `select_viewer` or
`--project` pins a project and reconnects to that project after a restart.
A failed call during restart returns an error; the next call rediscovers the
viewer. Mutating calls are never silently replayed. If several viewers are
running, the agent uses `list_viewers` and `select_viewer`, or configure the
adapter with `--project /absolute/path/to/board-project` to restrict discovery.
This is the **board project's folder**, not the CopperReview tool checkout.

The bridge is independent of model providers and agent hosts. Configuration
syntax varies by host. If installed into an existing Python environment,
`copper-review-mcp` or `python -m copper_review.agent_mcp` also works. The explicit
`COPPER_REVIEW_URL=http://127.0.0.1:PORT/#token=TOKEN` environment variable remains
available as a fallback; it disables automatic discovery and must be updated
after restarting the viewer. Use the **Agent MCP** URL printed by the CLI for
this fallback. The browser's CopperReview URL uses a different credential.

## Ask from your agent chat

1. Start the viewer with `--agents` and keep its browser tab open. It synchronizes
   selection and design data automatically, including when the question panel
   is closed. Static hosting and viewers without `--agents` do not share context.
2. Select a part, net or region in the viewer.
3. Ask your agent about it, or invoke the **explain-selection** MCP prompt in
   your host's prompt picker/command interface. The prompt accepts an optional
   `question`. Command presentation and naming depend on the host.
4. The agent calls `get_current_selection`, then answers in your existing chat.
   The result includes the session ID, context revision, synchronization time,
   selected entities, exact design hashes, available evidence and omissions.
   Synchronization normally takes about a second; background browser throttling
   can delay it. Check `synchronized_at` when timing matters.
5. To point something out, the agent calls `show_on_board` with `target`,
   `sha256` and an exact `selection` from that context. It can target either
   layout or electrical view. This only changes the visual selection.

If several viewers are running, choose one using `list_viewers/select_viewer`.
With several active tabs, the server chooses the one most recently focused or
used. The result identifies the chosen `session_id`, `chosen_by` and `last_used`.
Activity is synchronized on the next poll; polling alone does not change it.
Use `list_sessions/select_session` or pass `session_id` to override this choice.
An explicitly chosen tab becoming idle produces an error instead of switching
tabs. Copy the returned `session_id` into `show_on_board` to target that same tab.

Highlights are queued and acknowledged by the browser. Use
`get_navigation_status(session_id, command_id)` to distinguish applied, rejected
and expired highlights; a queued result alone does not prove anything was shown.
The server validates entity IDs and the exact design hash, and the browser checks
the hash again before navigation. One highlight is retained per tab; a newer
command supersedes the earlier one. Unapplied highlights expire after 30 seconds.
A browser receipt arriving after expiry can still confirm that the command was
applied. While either note editor contains a draft or an existing note is being
edited, navigation is rejected with a reason; save or cancel the note first.
These tools never create questions, answers or review notes.

### Selection resource and prompts

`copper-review://selection` returns the same context as
`get_current_selection`, using the explicitly selected or most recently used tab.
`resources/subscribe` enables `notifications/resources/updated` when its
revision or availability changes. The adapter checks small session metadata
once per second and emits notifications even while the host sends no requests.
The host decides whether to read the updated resource or include it in a turn;
notifications do not themselves launch a model. `resources/unsubscribe` stops
notifications. This uses the adapter's existing MCP 2025-11-25 and earlier
protocol support; no newer protocol support is claimed.

The adapter also provides two user-invoked MCP prompts:

- **explain-selection**: inspect the current selection and answer in the host
  chat, citing evidence and distinguishing facts, inference and unknowns.
- **answer-viewer-questions**: wait for sidebar questions while the host keeps
  the agent active, cite captured evidence, and avoid unsolicited audits.

Sampling is deliberately not the wake-up mechanism. MCP
[deprecated sampling in 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/client/sampling);
the newer protocol delivers sampling inside a client-initiated request.
It therefore does not solve idle-host wake-up. CopperReview neither advertises
nor requests sampling. The direct-chat path is the default and the mailbox
remains available for hosts that keep an agent active.

## Optional in-viewer questions

Use the **answer-viewer-questions** MCP prompt, or give the agent a task such as:

> Help me understand the design open in CopperReview. Wait for my questions,
> inspect each captured context and answer with evidence references. Explain
> the declared facts, distinguish inference, and identify missing information.
> Do not turn ordinary questions into a fault audit or modify the design. Keep
> waiting for questions while this review session is active.

The host still runs the agent. MCP configuration alone does not launch model
work or wake a host that has stopped the agent's turn. `wait_for_question` avoids
repeated polling by an **active** agent; it is not a background worker or an
automatic model launcher. No API key or model SDK is needed in CopperReview.

## Use the sidebar

1. Open **Ask about design** for the optional viewer conversation. Context
   sharing is already active when the viewer was started with `--agents`.
2. Ask a question, optionally selecting a component, net or region. You can
   select and inspect the board while the sidebar remains open. No selection
   is required for general board questions. Ctrl+Enter sends.
3. The sidebar distinguishes no agent connected, waiting, answering, and the
   agent's progress. **Cancel** prevents an outstanding answer from publishing;
   it does not forcibly terminate the model process in the external host.
4. Answers include expandable evidence excerpts. **Show on board** or **Show in
   schematic** selects the cited entity when the answer includes a selection.
5. New questions continue the conversation by referencing the preceding request.
   **Follow up** chooses an older question; **New topic** starts without a parent.
   **Ask again** sends a new request with fresh context and no parent.
6. **Export conversation** saves questions, answers, evidence excerpts and their
   design identities as `copper-review-conversation/v1` JSON.

Example questions:

- What is U1's role, and what supports that interpretation?
- Which pins connect to this net? Is the answer from the schematic or the PCB?
- Which declared power rails feed this component?
- Where is this part placed, and what does the export tell us about it?
- What information is missing to determine whether this interface is compatible?

Answers are not automatically added to layout or electrical review notes. If
you explicitly request findings and the agent supplies them, **Add findings to
review notes** imports them with agent attribution. Existing note editing,
resolution, persistence and export continue to work.

When a design revision changes, earlier answers remain readable but are clearly
marked as referring to an earlier revision. Their geometry navigation is disabled.
The board and electrical IR have independent hashes; being open together does
not prove that they came from the same build. Cite both when relying on both.

## Agent tools

| Tool | Purpose |
| --- | --- |
| `list_viewers` / `select_viewer` | Discover and choose local viewer processes without exposing credentials. |
| `list_sessions` | List browser tabs with their design identities. |
| `select_session(session_id)` | Choose the active tab for this MCP connection. |
| `get_current_selection(session_id?)` | Read synchronized context for host-side questions, without claiming or queuing anything. |
| `show_on_board(target, sha256, selection, session_id?)` | Queue a hash-checked visual highlight in the board or schematic. |
| `get_navigation_status(session_id, command_id)` | Check the browser's acknowledgement of a highlight. |
| `get_context(session_id)` | Inspect the latest browser-synchronized selection and data. |
| `wait_for_question(agent, session_id?, timeout_seconds?)` | Wait up to 45 seconds and atomically claim the next question; returns the captured context or null on timeout. |
| `get_request(request_id)` | Read a captured question, its parent ID and any answer. |
| `report_progress(request_id, claim_id, agent, message)` | Report useful progress and renew a claim. |
| `publish_answer(...)` | Return an informational answer with evidence and limitations. |
| `list_requests(session_id?, status?)` | Inspect queue metadata, including queued, answering, completed, cancelled and stale requests. |
| `publish_feedback(...)` | Optional structured findings, for explicitly requested reviews. |

After receiving a question, use its immutable context rather than the changing
live selection. Follow `parent_id` with `get_request` when earlier questions or
answers are needed. Both answer and findings publication require the `claim_id`
returned by `wait_for_question`, with the same agent name. `list_requests` is
for inspection and does not claim work. Claims expire after five
minutes without progress and become eligible for another agent; report progress
before then for longer work. Cancellation and expired claims reject publication.
An agent should call `wait_for_question` again after answering or a wait timeout,
while authorized to continue by its user/host.

Example answer arguments (replace all IDs, hashes and evidence paths with values
from the actual question):

```json
{
  "request_id": "QUESTION_UUID",
  "claim_id": "CLAIM_UUID",
  "answer_id": "answer-1",
  "agent": "Design helper",
  "based_on": {"layout": "EXACT_BOARD_SHA256"},
  "answer": "U1 is labeled Controller in the export. Its source instance is control.U1. The label suggests its role; the export alone does not establish its full behavior.",
  "limitations": "The part contract or datasheet is needed to explain its behavior.",
  "citations": [{
    "label": "U1 component record",
    "pointer": "/documents/layout/context/components/0",
    "selection": {"components": ["U1"], "nets": [], "region": null}
  }]
}
```

`answer` is plain text. `based_on` names the exact hashes of every document the
answer relies on. Each citation is a JSON pointer into the captured question
context and an optional exact selection. Electrical selections use
`{"kind":"net","id":"DATA"}` (also component, pin and bus). Pointer escapes
are `~1` for slash and `~0` for tilde. The server verifies that pointers resolve,
copies bounded evidence excerpts, and validates selected entity IDs. These
checks establish where the agent pointed, **not** whether its reasoning is
correct or its conclusion qualified. An answer about missing information may
have no citations; explain that limitation explicitly.

Wrong design hashes, invalid evidence pointers and unknown selected entities
are rejected. If a cited design has changed, publication is marked stale and
the browser rechecks identity before enabling navigation. Repeating identical
publication arguments is idempotent. Changing a completed answer requires a
new question. Agent display names are self-reported, not authenticated identities.

## Available context and boundaries

`copper-review-agent-context/v1` carries separate layout and electrical documents.

- Layout: exact board identity, selected geometry via the compact review
  snapshot, layers, issues, notes, and a bounded board catalog. The catalog has
  up to 500 component records, 64 pads per component and 1,000 net names, with
  omitted counts. It supports general questions without copying all copper.
  Select an entity for detailed geometry beyond those catalog limits.
- Electrical: exact IR identity/provenance, native electrical IR, entity IDs,
  selected entity, current view, declared power state, compiler check and notes.
  A separate `selection_context` retains nearby declared connectivity: up to
  32 components (64 pins each) and 64 nets (128 pins each), with omitted counts.

Context is rebuilt only when relevant design, selection, layer or note state
changes. The 4 MiB limit counts compact UTF-8 JSON bytes. If needed, the browser
progressively omits full electrical IR, the layout catalog, electrical notes,
layout notes and issues. Both the sidebar and the captured `omissions` field
make this visible; agents must not treat omitted data as checked. If the remaining
selection is still too large, a single persistent error asks for a smaller
selection/design; unchanged context is not repeatedly uploaded. Exact hashes
and selected context remain intact. Electrical findings need an explicit
entity selection when the question has none.

The bridge does not fetch datasheets or original source text, infer connectivity
from track counts, simulate circuits, or verify RF/power/assembly qualification.
The agent can use its independently authorized tools for additional sources,
but must identify that evidence and distinguish it from the captured design.
Missing facts remain unknown. Notes and all design text are data, not executable
instructions. Physical algorithm changes belong in CopperScript.

The HTTP mailbox is token-authenticated and loopback-only. Agents receive a
separate credential accepted only by POST `/api/agents/tool`; it cannot update
browser context, enqueue reviewer questions or import designs. The browser
credential cannot call the agent tool endpoint. Static hosting and
network serving continue without `--agents`. The adapter refuses redirects and
non-loopback URLs and bypasses network proxies. Discovery records live under
`%LOCALAPPDATA%/CopperReview/agents` on Windows, where URLs are protected with
user-bound [Windows DPAPI](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata).
On POSIX the directory is under `$XDG_STATE_HOME/copper-review/agents` (default
`~/.local/state`) with mode 0700 and record files mode 0600. Tests can override
the location with `COPPER_REVIEW_REGISTRY`. Graceful shutdown removes its record;
discovery also prunes records whose process is known to have exited. Records
with unknown process status are retained, and unreachable viewers are ignored.
Discovery considers the 64 newest retained records.
Records include the viewer package version. The adapter warns on stderr once
per viewer/version mismatch (including older records with no version); update
the adapter or reinstall the bundled extension after upgrading the viewer.

Limits remain explicit: eight browser sessions, 32 retained questions, 4 MiB per
context, 32 citations/findings per answer, 32,000 answer characters and 3,000
characters per evidence excerpt. At capacity, completed/cancelled requests are
evicted before pending/claimed work. Parent history may eventually be evicted;
the agent must treat an unavailable parent as missing context. A tab keeps its
session ID in sessionStorage across reloads, preserving its conversation.
An origin-scoped Web Lock prevents a duplicated tab from reusing that ID and
overwriting the original context. Browsers without Web Locks use a new ID on
each load instead; reload persistence is unavailable on those browsers.
At session capacity the oldest idle tab and its requests are evicted; eight
active tabs require closing one before another can connect. Page exit detaches
the session; a tab without a heartbeat for two minutes is also considered idle.
Idle tabs do not supply new work to agents. Already claimed work may finish.
Tab sessions expire after an hour without synchronization. Conversations use
server memory, and restarting the server clears the mailbox and queued highlights.
Export the conversation to retain it. Ordinary review notes keep their normal
hash-keyed browser persistence.

## Verification

Build the Claude Desktop extension with:

```console
python -m copper_review.agent_setup --bundle dist/copper-review.mcpb
```

An optional `--python` sets the installer's default interpreter path. The bundle
contains only the adapter, discovery code, launcher, package initializer,
manifest and short instructions. It uses MCPB manifest 0.3. To validate it,
extract `manifest.json` and run the official `mcpb validate manifest.json`.
No generated bundle or machine-specific paths need to be committed.

Run `python -m unittest discover -s tests -v` and `npm test`. Python tests cover
discovery and dead-process pruning, reconnecting, credential separation,
mandatory claims, bounded waits, idle-session eviction, compact UTF-8 limits,
immutable shared contexts, progress, cancellation, evidence resolution and the
MCP/HTTP boundary. Host-chat tests cover tab selection, highlight expiry and
acknowledgement, resource subscriptions and user-invoked prompts.
JavaScript tests verify context caching, size fallback and connection-state
display. Python tests also execute generated configurations and the extracted
bundle from unrelated working directories and exercise connection proof,
expiry, cross-tab isolation and credential restrictions.

With Playwright available, run `node tests/questions-browser.mjs` for an actual
automatically discovered MCP subprocess and browser Q&A. It first checks host
chat with the sidebar unopened, setup for ChatGPT/Claude, extension download,
live connection proof, notifications while MCP stdin is idle, prompt
discovery and acknowledged highlights without creating notes. It checks that answers
do not create notes, selections remain usable, citations navigate, follow-ups
retain context, cancellations reject late answers, revisions invalidate answers,
conversations export, reloads preserve sessions, Ask again starts a new thread,
progress preserves existing DOM rows, and oversized IR falls back to selected
connectivity. `node tests/agents-browser.mjs` additionally checks
optional findings and note persistence. Set `COPPER_PYTHON`,
`COPPER_PLAYWRIGHT_MODULE` and `COPPER_BROWSER_EXECUTABLE` when needed.
