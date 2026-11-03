# CopperReview on Ubuntu (or any system with make, uv and Node.js 20+).
#
#   make setup                                  check tools, install the package, fetch the compiler
#   make serve PROJECT=../BysseControl-32       compile a project folder in the browser (reload = recompile)
#   make serve PROJECT=../board ENTRY=boards/main/board.copper
#   make serve IR=build/electrical.ir.json      open a compiled electrical IR
#   make serve BOARD=build/placed.kicad_pcb     open a PCB
#   make serve PROJECT=../board HOST=0.0.0.0    also reachable from other machines (plain HTTP)
#   make test                                   Python and Node tests
#
# The browser compiler is fetched on first use and again whenever .copperscript-version changes.

PROJECT ?=
ENTRY ?=
IR ?=
BOARD ?=
STAGE ?= unknown
HOST ?= 127.0.0.1
PORT ?= 8769
OPEN ?= yes

WASM := copper_review/web/wasm/manifest.json
SERVE_ARGS := $(if $(PROJECT),--project "$(PROJECT)") $(if $(ENTRY),--entry "$(ENTRY)") \
	$(if $(IR),--electrical-ir "$(IR)") $(if $(BOARD),"$(BOARD)" --stage $(STAGE)) \
	--host $(HOST) --port $(PORT) $(if $(filter yes,$(OPEN)),,--no-browser)

.DEFAULT_GOAL := help
.PHONY: help setup tools serve wasm wasm-build test test-wasm static clean

help:
	@sed -n 's/^#   //p' Makefile

tools:
	@command -v uv >/dev/null || { echo "uv is missing: curl -LsSf https://astral.sh/uv/install.sh | sh"; exit 1; }
	@command -v node >/dev/null || { echo "Node.js 20+ is missing: https://nodejs.org or 'sudo apt install nodejs' on Ubuntu 24.04+"; exit 1; }
	@node -e 'if(+process.versions.node.split(".")[0]<20){console.error(`Node.js 20+ is needed, found ${process.version}`);process.exit(1)}'

setup: tools $(WASM)
	uv sync

# Fetched, not built: the copy GitHub Pages built from the pinned compiler commit, checked
# against its manifest. Use `make wasm-build` to compile it from a CopperScript checkout instead.
$(WASM): .copperscript-version
	node scripts/fetch-wasm.mjs
	@touch $@

wasm:
	node scripts/fetch-wasm.mjs

wasm-build:
	npm run build:wasm

serve: $(WASM)
	uv run copper-review $(SERVE_ARGS)

test:
	uv run python -m unittest discover -s tests
	npm test

test-wasm: $(WASM)
	npm run test:wasm

static: $(WASM)
	npm run build:static

clean:
	rm -rf copper_review/web/wasm copper_review/web/wasm.download
