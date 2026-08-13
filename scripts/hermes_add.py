#!/usr/bin/env python3
"""Register (or remove) this MCP server in Hermes Agent's config.yaml.

Hermes has no `mcp add` CLI equivalent to `claude mcp add`, so registration is
a direct edit of ~/.hermes/config.yaml under the top-level `mcp_servers` key.
That file is the user's live agent config, so this script is deliberately
paranoid: it backs up first, writes atomically via a temp file + rename, and
re-parses the result before committing. Any failure restores the backup.

Idempotent: re-running with the same arguments is a no-op that reports
"unchanged" rather than duplicating or rewriting the entry.

Usage:
    hermes_add.py --name NAME --command PATH [--arg A]... [--env K=V]...
    hermes_add.py --name NAME --remove
    hermes_add.py --name NAME ... --dry-run
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import tempfile
from datetime import datetime
from pathlib import Path


def _yaml_backend():
    """Return a loader for validation only.

    Note we deliberately do NOT round-trip the whole document when writing.
    Both pyyaml and ruamel reflow untouched content (sequence indentation,
    long-string wrap column), which turns a three-line addition into a
    400-line diff on the user's live agent config. Writes are done as a
    surgical text splice instead; see `_splice`.
    """
    try:
        from ruamel.yaml import YAML  # noqa: PLC0415

        engine = YAML()
        engine.preserve_quotes = True

        def _ruamel_load(text):
            return engine.load(text) or {}

        return _ruamel_load
    except ImportError:
        import yaml  # noqa: PLC0415

        def _pyyaml_load(text):
            return yaml.safe_load(text) or {}

        return _pyyaml_load


_LOAD_TEXT = _yaml_backend()


def default_config_path() -> Path:
    return Path(os.environ.get("HERMES_CONFIG", "~/.hermes/config.yaml")).expanduser()


def _load(path: Path):
    return _LOAD_TEXT(path.read_text(encoding="utf-8"))


def _render(name: str, entry: dict) -> list[str]:
    """Render one server entry as YAML lines at Hermes' 2-space indent."""
    lines = [f"  {name}:"]
    for key, value in entry.items():
        if isinstance(value, list):
            lines.append(f"    {key}:")
            lines.extend(f"      - {item}" for item in value)
        elif isinstance(value, dict):
            lines.append(f"    {key}:")
            # Quote env values: unquoted YAML coerces "1" to int and "yes" to
            # bool, which silently corrupts tokens and numeric-looking secrets.
            lines.extend(f'      {k}: "{v}"' for k, v in value.items())
        elif isinstance(value, bool):
            lines.append(f"    {key}: {str(value).lower()}")
        else:
            lines.append(f"    {key}: {value}")
    return lines


def _block_bounds(lines: list[str], name: str) -> tuple[int, int] | None:
    """Line span [start, end) of `  <name>:` inside the mcp_servers block."""
    try:
        top = next(i for i, ln in enumerate(lines) if ln.rstrip() == "mcp_servers:")
    except StopIteration:
        return None
    start = None
    for i in range(top + 1, len(lines)):
        line = lines[i]
        if line.strip() and not line.startswith(" "):
            break  # left the mcp_servers block entirely
        if line.rstrip() == f"  {name}:":
            start = i
            continue
        if start is not None:
            # Entry ends at the next sibling key or any shallower line.
            if line.strip() and not line.startswith("    "):
                return (start, i)
    return (start, len(lines)) if start is not None else None


def _splice(text: str, name: str, entry: dict | None) -> str:
    """Add, replace, or delete one mcp_servers entry, touching nothing else."""
    lines = text.splitlines()
    bounds = _block_bounds(lines, name)

    if entry is None:
        if bounds is None:
            return text
        start, end = bounds
        return "\n".join(lines[:start] + lines[end:]) + "\n"

    rendered = _render(name, entry)
    if bounds is not None:
        start, end = bounds
        return "\n".join(lines[:start] + rendered + lines[end:]) + "\n"

    # New entry: append under an existing mcp_servers block, or create one.
    try:
        top = next(i for i, ln in enumerate(lines) if ln.rstrip() == "mcp_servers:")
    except StopIteration:
        return "\n".join([*lines, "mcp_servers:", *rendered]) + "\n"

    insert_at = len(lines)
    for i in range(top + 1, len(lines)):
        if lines[i].strip() and not lines[i].startswith(" "):
            insert_at = i
            break
    while insert_at > top + 1 and not lines[insert_at - 1].strip():
        insert_at -= 1  # keep blank separator lines below the block
    return "\n".join(lines[:insert_at] + rendered + lines[insert_at:]) + "\n"


def _entry(args) -> dict:
    entry: dict = {"command": args.command}
    if args.arg:
        entry["args"] = list(args.arg)
    if args.env:
        env: dict = {}
        for pair in args.env:
            key, sep, value = pair.partition("=")
            if not sep:
                raise SystemExit(f"error: --env expects KEY=VALUE, got {pair!r}")
            env[key] = value
        entry["env"] = env
    if args.timeout is not None:
        entry["timeout"] = args.timeout
    entry["enabled"] = True
    return entry


def _write_atomic(path: Path, text: str) -> None:
    """Write via temp file + rename so a crash cannot truncate the config."""
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=".hermes_add.")
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        _load(tmp)  # re-parse before committing; raises if we produced garbage
        shutil.copymode(path, tmp)
        tmp.replace(path)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--name", required=True, help="MCP server name in Hermes")
    p.add_argument("--command", help="Absolute path to the launcher/executable")
    p.add_argument("--arg", action="append", help="Argument for the command (repeatable)")
    p.add_argument("--env", action="append", help="KEY=VALUE for the subprocess (repeatable)")
    p.add_argument("--timeout", type=int, help="Per-tool-call timeout in seconds")
    p.add_argument("--config", help="Config path (default $HERMES_CONFIG or ~/.hermes/config.yaml)")
    p.add_argument("--remove", action="store_true", help="Remove the entry instead of adding")
    p.add_argument("--dry-run", action="store_true", help="Report the change; write nothing")
    return p


def _plan(args, path: Path) -> tuple[str, dict | None] | None:
    """Resolve the intended change, or None when there is nothing to do."""
    existing = (_load(path).get("mcp_servers") or {}).get(args.name)

    if args.remove:
        if existing is None:
            print(f"'{args.name}' not registered in {path} — nothing to do")
            return None
        return "remove", None

    entry = _entry(args)
    if existing is not None and dict(existing) == entry:
        print(f"'{args.name}' already registered identically — unchanged")
        return None
    return ("update" if existing is not None else "add"), entry


def _commit(args, path: Path, action: str, entry: dict | None) -> int:
    """Back up, splice, write atomically, verify — restoring on any failure."""
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup = path.with_suffix(f".yaml.bak.{stamp}")
    shutil.copy2(path, backup)

    def _restore(reason: str) -> int:
        shutil.copy2(backup, path)
        print(f"error: {reason}; restored {backup}", file=sys.stderr)
        return 1

    try:
        _write_atomic(path, _splice(path.read_text(encoding="utf-8"), args.name, entry))
    except Exception as exc:
        return _restore(str(exc))

    present = _load(path).get("mcp_servers", {}).get(args.name) is not None
    if present is bool(args.remove):
        return _restore("post-write verification failed")

    print(f"{action}: '{args.name}' in {path}")
    print(f"  backup: {backup}")
    print("  restart Hermes Agent to pick up the change (no hot-reload)")
    return 0


def main() -> int:
    parser = _parser()
    args = parser.parse_args()

    path = Path(args.config).expanduser() if args.config else default_config_path()
    if not path.exists():
        print(f"hermes config not found: {path}", file=sys.stderr)
        print("Is Hermes Agent installed? Skipping registration.", file=sys.stderr)
        return 0  # not an error: Hermes is an optional target
    if not args.remove and not args.command:
        parser.error("--command is required unless --remove is given")

    planned = _plan(args, path)
    if planned is None:
        return 0
    action, entry = planned

    if args.dry_run:
        print(f"[dry-run] would {action} '{args.name}' in {path}")
        if entry:
            print(f"[dry-run]   {entry}")
        return 0

    return _commit(args, path, action, entry)


if __name__ == "__main__":
    raise SystemExit(main())
