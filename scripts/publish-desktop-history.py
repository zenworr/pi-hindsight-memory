#!/usr/bin/env python3
"""Capture and atomically publish a complete desktop history generation.

The transport can copy a captured directory to <base>/incoming/<generation>.
The receiver must run `promote` after transfer. No importer reads `incoming`.
"""

import argparse
from contextlib import closing
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import tempfile
from datetime import datetime, timezone

SOURCES = {
    "pi": ".pi/agent/sessions",
    "codex": ".codex/sessions",
    "claude": ".claude/projects",
}
DATABASES = {
    "codex-state": ".codex/state_5.sqlite",
    "opencode": ".local/share/opencode/opencode.db",
}
GENERATION = re.compile(r"^[a-zA-Z0-9_-]{8,80}$")


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def hash_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def files_at(root):
    if not root.is_dir():
        raise FileNotFoundError(f"Missing history root: {root}")
    found = {}
    for directory, directories, files in os.walk(root, followlinks=False):
        directories[:] = sorted(d for d in directories if not (Path(directory) / d).is_symlink())
        for name in sorted(files):
            file = Path(directory) / name
            if file.suffix != ".jsonl" or file.is_symlink():
                continue
            info = file.stat()
            if stat.S_ISREG(info.st_mode):
                found[str(file.relative_to(root))] = (info.st_size, info.st_mtime_ns)
    return found


def copy_file(source, destination, expected):
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with source.open("rb") as original, destination.open("xb") as copy:
        opened = os.fstat(original.fileno())
        if (opened.st_size, opened.st_mtime_ns) != expected:
            raise RuntimeError(f"Source changed before copy: {source}")
        shutil.copyfileobj(original, copy, length=1024 * 1024)
        after = os.fstat(original.fileno())
        if (after.st_size, after.st_mtime_ns) != expected:
            raise RuntimeError(f"Source changed during copy: {source}")
    os.chmod(destination, 0o600)
    os.utime(destination, ns=(expected[1], expected[1]))
    if (destination.stat().st_size, destination.stat().st_mtime_ns) != expected:
        raise RuntimeError(f"Copy does not match source metadata: {source}")


def backup_database(source, destination):
    if not source.is_file() or source.is_symlink():
        raise FileNotFoundError(f"Missing database: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)) as original:
        with closing(sqlite3.connect(destination)) as copy:
            original.backup(copy)
            # A transport snapshot must be one self-contained SQLite file, not WAL sidecars.
            copy.execute("PRAGMA journal_mode=DELETE")
            if copy.execute("PRAGMA quick_check").fetchone() != ("ok",):
                raise RuntimeError(f"Database backup failed integrity check: {source}")
    destination.chmod(0o600)
    source_mtime = source.stat().st_mtime_ns
    os.utime(destination, ns=(source_mtime, source_mtime))


def capture(home, destination, generation):
    if not GENERATION.fullmatch(generation):
        raise ValueError("Invalid generation name")
    destination.mkdir(mode=0o700)
    started = timestamp()
    entries = []
    snapshots = {name: files_at(home / logical) for name, logical in SOURCES.items()}
    for name, logical in SOURCES.items():
        root = home / logical
        for relative, expected in snapshots[name].items():
            output = destination / name / relative
            copy_file(root / relative, output, expected)
            entries.append({"path": f"{name}/{relative}", "size": expected[0], "mtimeNs": expected[1], "sha256": hash_file(output)})
        if files_at(root) != snapshots[name]:
            raise RuntimeError(f"History root changed during capture: {root}")
    for name, logical in DATABASES.items():
        output = destination / name / Path(logical).name
        backup_database(home / logical, output)
        entries.append({"path": str(output.relative_to(destination)), "size": output.stat().st_size, "mtimeNs": output.stat().st_mtime_ns, "sha256": hash_file(output)})
    # Recheck after database backups, not only immediately after each file tree.
    for name, logical in SOURCES.items():
        if files_at(home / logical) != snapshots[name]:
            raise RuntimeError(f"History root changed during database backup: {home / logical}")
    manifest = {"version": 1, "origin": "desktop", "sourceHome": str(home.resolve()), "generation": generation, "startedAt": started, "completedAt": timestamp(), "sourceRoots": SOURCES, "databases": DATABASES, "files": sorted(entries, key=lambda entry: entry["path"])}
    (destination / "manifest.json").write_text(json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n")
    (destination / "manifest.json").chmod(0o600)
    verify(destination)
    return manifest


def verify(directory):
    directory = directory.resolve(strict=True)
    manifest = json.loads((directory / "manifest.json").read_text())
    if manifest.get("version") != 1 or manifest.get("origin") != "desktop" or manifest.get("sourceRoots") != SOURCES or manifest.get("databases") != DATABASES or manifest.get("generation") != directory.name:
        raise ValueError("Invalid desktop snapshot manifest")
    expected = {"manifest.json"}
    for entry in manifest["files"]:
        name = entry["path"]
        if not isinstance(name, str) or name.startswith("/") or ".." in Path(name).parts or name in expected:
            raise ValueError("Invalid or repeated snapshot path")
        expected.add(name)
        target = directory / name
        info = target.lstat()
        if not stat.S_ISREG(info.st_mode) or (info.st_size, info.st_mtime_ns) != (entry["size"], entry["mtimeNs"]) or hash_file(target) != entry["sha256"]:
            raise RuntimeError(f"Snapshot verification failed: {name}")
        if name.endswith(".sqlite") or name.endswith(".db"):
            with closing(sqlite3.connect(target.as_uri() + "?mode=ro", uri=True)) as database:
                if database.execute("PRAGMA quick_check").fetchone() != ("ok",):
                    raise RuntimeError(f"Snapshot database is damaged: {name}")
    observed = set()
    for folder, directories, files in os.walk(directory, followlinks=False):
        for name in directories:
            if (Path(folder) / name).is_symlink():
                raise RuntimeError("Snapshot contains a symlinked directory")
        observed.update(str((Path(folder) / name).relative_to(directory)) for name in files)
    if expected != observed:
        raise RuntimeError("Snapshot has missing or unexpected files")
    return manifest


def promote(base, generation):
    if not GENERATION.fullmatch(generation):
        raise ValueError("Invalid generation name")
    if base.is_symlink() or not base.is_dir():
        raise ValueError("The feed base must be a private directory")
    if base.stat().st_mode & 0o077:
        raise PermissionError("The feed base must have mode 0700")
    with (base / ".publish.lock").open("a+") as lock:
        os.chmod(lock.name, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        incoming = base / "incoming" / generation
        if incoming.is_symlink():
            raise ValueError("Refusing a symlinked incoming generation")
        verify(incoming)
        (base / "generations").mkdir(mode=0o700, exist_ok=True)
        published = base / "generations" / generation
        if published.exists() or published.is_symlink():
            raise FileExistsError(published)
        incoming.rename(published)
        with tempfile.NamedTemporaryFile(dir=base, prefix=".current-", delete=True) as temporary:
            pointer = Path(temporary.name)
        pointer.symlink_to(Path("generations") / generation)
        pointer.replace(base / "current")
        return published


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    capture_cmd = commands.add_parser("capture")
    capture_cmd.add_argument("--home", type=Path, default=Path.home())
    capture_cmd.add_argument("--output", type=Path, required=True)
    capture_cmd.add_argument("--generation", required=True)
    verify_cmd = commands.add_parser("verify")
    verify_cmd.add_argument("directory", type=Path)
    promote_cmd = commands.add_parser("promote")
    promote_cmd.add_argument("--base", type=Path, required=True)
    promote_cmd.add_argument("--generation", required=True)
    args = parser.parse_args()
    if args.command == "capture":
        if args.output.exists() or args.output.is_symlink():
            raise FileExistsError(args.output)
        try:
            result = capture(args.home, args.output, args.generation)
        except BaseException:
            # A failed capture is never a candidate for publication.
            if args.output.is_dir() and not args.output.is_symlink():
                shutil.rmtree(args.output)
            raise
        print(json.dumps({"generation": result["generation"], "files": len(result["files"])}))
    elif args.command == "verify":
        result = verify(args.directory)
        print(json.dumps({"generation": result["generation"], "files": len(result["files"])}))
    else:
        result = promote(args.base, args.generation)
        print(f"Published {result.name}")


if __name__ == "__main__":
    main()
