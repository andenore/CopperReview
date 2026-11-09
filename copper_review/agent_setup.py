"""Local connection instructions and a dependency-free Claude Desktop bundle."""
import argparse
import io
import json
import os
from pathlib import Path
import shlex
import sys
import zipfile

from . import __version__


def setup_config():
    # Use the running interpreter rather than a possibly missing PATH command or uv.
    command = str(Path(sys.executable).resolve())
    args = ["-I", str(Path(__file__).with_name("agent_stdio.py").resolve())]
    env = {"COPPER_REVIEW_URL": ""}
    if os.environ.get("COPPER_REVIEW_REGISTRY"):
        env["COPPER_REVIEW_REGISTRY"] = str(Path(os.environ["COPPER_REVIEW_REGISTRY"]).resolve())
    config = {"command": command, "args": args, "env": env}
    # PowerShell single quotes prevent interpolation, including $() in installation paths.
    quote = (lambda s: "'" + s.replace("'", "''") + "'") if os.name == "nt" else shlex.quote
    launch = " ".join(quote(s) for s in [command, *args])
    env_flags = "--env " + " ".join(quote(k + "=" + v) for k, v in env.items())
    toml = "[mcp_servers.copper-review]\ncommand = " + json.dumps(command) + "\nargs = " + json.dumps(args)
    toml += "\n[mcp_servers.copper-review.env]\n" + "\n".join(k + " = " + json.dumps(v) for k, v in env.items()) + "\n"
    return {"config": config, "claude_json": json.dumps({"mcpServers": {"copper-review": config}}, indent=2),
            "codex_toml": toml, "claude_command": f"claude mcp add {env_flags} --transport stdio --scope user copper-review {quote('--')} {launch}",
            "shell": "PowerShell" if os.name == "nt" else "shell",
            "runtime_available": Path(command).is_file() and Path(args[1]).is_file()}


def extension_bundle(python=None):
    config = setup_config()
    manifest = {
        "manifest_version": "0.3", "name": "copper-review", "display_name": "CopperReview",
        "version": __version__, "description": "Ask about your selected PCB or schematic and highlight design entities.",
        "author": {"name": "CopperReview contributors"},
        "homepage": "https://github.com/andenore/CopperReview",
        "server": {"type": "python", "entry_point": "copper_review/agent_stdio.py",
                   "mcp_config": {"command": "${user_config.python_path}",
                                  "args": ["-I", "${__dirname}/copper_review/agent_stdio.py"], "env": config["config"]["env"]}},
        "compatibility": {"platforms": ["win32", "darwin", "linux"], "runtimes": {"python": ">=3.11"}},
        "user_config": {"python_path": {"type": "string", "title": "Python executable",
                       "description": "Python 3.11 or newer. Prefilled with the interpreter running your viewer; change it if installing on another computer.",
                       "default": python or config["config"]["command"], "required": True}},
        "tools_generated": True, "prompts_generated": True,
    }
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps(manifest, indent=2))
        # An explicit allowlist prevents board files, credentials or development artifacts entering the bundle.
        for name in ("__init__.py", "agent_stdio.py", "agent_mcp.py", "agent_discovery.py"):
            archive.writestr("copper_review/" + name, Path(__file__).with_name(name).read_bytes())
        archive.writestr("README.txt", "Start CopperReview with --agents, install this extension, then select a part and ask about it in Claude.\n"
                         "The adapter is bundled. Python 3.11+ is required; its path is prefilled for the computer that generated this bundle.\n"
                         "No credentials or board data are bundled. A connected host can read shared design context and request visual highlights.\n")
    return output.getvalue()


def main():
    parser = argparse.ArgumentParser(description="Package the CopperReview Claude Desktop extension")
    parser.add_argument("--bundle", type=Path, required=True, help="Output .mcpb file")
    parser.add_argument("--python", help="Default Python executable for the installer (defaults to the running interpreter)")
    args = parser.parse_args()
    args.bundle.parent.mkdir(parents=True, exist_ok=True)
    args.bundle.write_bytes(extension_bundle(args.python))
    print(args.bundle.resolve())


if __name__ == "__main__":
    main()
