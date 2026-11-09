"""Absolute-path launcher for desktop hosts, independent of their working directory."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from copper_review.agent_mcp import main

if __name__ == "__main__":
    raise SystemExit(main())
