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
import subprocess
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


class SourceChanged(RuntimeError):
    pass


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
            raise SourceChanged(f"Source changed before copy: {source}")
        shutil.copyfileobj(original, copy, length=1024 * 1024)
        after = os.fstat(original.fileno())
        if (after.st_size, after.st_mtime_ns) != expected:
            raise SourceChanged(f"Source changed during copy: {source}")
    os.chmod(destination, 0o600)
    os.utime(destination, ns=(expected[1], expected[1]))
    if (destination.stat().st_size, destination.stat().st_mtime_ns) != expected:
        raise RuntimeError(f"Copy does not match source metadata: {source}")


def validate_jsonl(file):
    with file.open("rb") as stream:
        for line in stream:
            if not line.endswith(b"\n"):
                raise SourceChanged(f"Active JSONL has an incomplete final record: {file}")
            try:
                json.loads(line)
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise ValueError(f"Malformed complete JSONL record: {file}") from error


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


def capture(home, destination, generation, previous=None):
    if not GENERATION.fullmatch(generation):
        raise ValueError("Invalid generation name")
    if previous and (previous.get("version") != 1 or previous.get("origin") != "desktop" or previous.get("sourceHome") != str(home.resolve())):
        raise ValueError("Previous manifest does not match the desktop history source")
    previous_entries = {entry["path"]: entry for entry in previous["files"]} if previous else {}
    if previous and (len(previous_entries) != len(previous["files"]) or any(not isinstance(name, str) or Path(name).is_absolute() or ".." in Path(name).parts for name in previous_entries)):
        raise ValueError("Invalid path in the previous manifest")
    destination.mkdir(mode=0o700)
    started = timestamp()
    entries = {}
    captured = {}
    deferred = set()
    omitted = set()
    snapshots = {name: files_at(home / logical) for name, logical in SOURCES.items()}

    def defer(name):
        (destination / name).unlink(missing_ok=True)
        if name in previous_entries:
            entries[name] = previous_entries[name]
            deferred.add(name)
        else:
            entries.pop(name, None)
            omitted.add(name)

    for name, logical in SOURCES.items():
        root = home / logical
        for relative, expected in snapshots[name].items():
            path = f"{name}/{relative}"
            output = destination / path
            try:
                copy_file(root / relative, output, expected)
                validate_jsonl(output)
            except SourceChanged:
                defer(path)
                continue
            entries[path] = {"path": path, "size": expected[0], "mtimeNs": expected[1], "sha256": hash_file(output)}
            captured[path] = expected
        for path in previous_entries:
            if path.startswith(f"{name}/") and path[len(name) + 1:] not in snapshots[name]:
                defer(path)
    for name, logical in DATABASES.items():
        output = destination / name / Path(logical).name
        backup_database(home / logical, output)
        path = str(output.relative_to(destination))
        entries[path] = {"path": path, "size": output.stat().st_size, "mtimeNs": output.stat().st_mtime_ns, "sha256": hash_file(output)}
    # A writer can append after its file was copied but before the database backups finish.
    for name, logical in SOURCES.items():
        observed = files_at(home / logical)
        for path, expected in captured.items():
            if path.startswith(f"{name}/") and observed.get(path[len(name) + 1:]) != expected:
                defer(path)
    manifest = {"version": 1, "origin": "desktop", "sourceHome": str(home.resolve()), "generation": generation, "startedAt": started, "completedAt": timestamp(), "sourceRoots": SOURCES, "databases": DATABASES, "files": sorted(entries.values(), key=lambda entry: entry["path"]), "deferred": sorted(deferred), "omittedActive": sorted(omitted)}
    if deferred:
        manifest["previousGeneration"] = previous["generation"]
    (destination / "manifest.json").write_text(json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n")
    (destination / "manifest.json").chmod(0o600)
    if not deferred:
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
        manifest = json.loads((incoming / "manifest.json").read_text())
        deferred = manifest.get("deferred", [])
        if deferred:
            previous = (base / "current").resolve(strict=True)
            if previous.name != manifest.get("previousGeneration"):
                raise RuntimeError("The previous feed generation changed during capture")
            previous_entries = {entry["path"]: entry for entry in verify(previous)["files"]}
            requested = {entry["path"]: entry for entry in manifest["files"]}
            for name in deferred:
                if not isinstance(name, str) or Path(name).is_absolute() or ".." in Path(name).parts or previous_entries.get(name) != requested.get(name) or name not in requested:
                    raise ValueError("Deferred file does not match the previous verified feed")
                source = previous / name
                if not stat.S_ISREG(source.lstat().st_mode):
                    raise ValueError("Deferred feed source is not a regular file")
                target = incoming / name
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                if not target.parent.resolve().is_relative_to(incoming.resolve()):
                    raise ValueError("Deferred feed target escapes the incoming generation")
                os.link(source, target)
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


def assert_importer_stopped():
    service = subprocess.run(["systemctl", "--user", "is-active", "pi-hindsight-importer.service"], capture_output=True, check=False)
    if service.returncode == 0:
        raise RuntimeError("Stop the dev importer before pruning feed generations")
    for pid in Path("/proc").glob("[0-9]*"):
        if pid.name == str(os.getpid()):
            continue
        try:
            if "dist/src/importer/cli.js" in (pid / "cmdline").read_bytes().replace(b"\0", b" ").decode(errors="ignore"):
                raise RuntimeError("An importer command is still using a feed generation")
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue


def prune(base, keep):
    if keep < 2 or base.is_symlink() or not base.is_dir() or base.stat().st_mode & 0o077:
        raise ValueError("Pruning requires a private feed and at least two retained generations")
    assert_importer_stopped()
    with (base / ".publish.lock").open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        current = (base / "current").resolve(strict=True)
        generations = base / "generations"
        if generations.is_symlink():
            raise ValueError("Current feed does not point to a published generation")
        generations = generations.resolve(strict=True)
        if current.parent != generations or not current.is_dir():
            raise ValueError("Current feed does not point to a published generation")
        candidates = sorted((item for item in generations.iterdir() if item.is_dir() and not item.is_symlink()), key=lambda item: item.name, reverse=True)
        if len(candidates) != len(list(generations.iterdir())):
            raise ValueError("Unexpected entry in the generations directory")
        retained = set(candidates[:keep]) | {current}
        for item in candidates:
            if item not in retained:
                shutil.rmtree(item)
        return len(candidates) - len(retained)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    capture_cmd = commands.add_parser("capture")
    capture_cmd.add_argument("--home", type=Path, default=Path.home())
    capture_cmd.add_argument("--output", type=Path, required=True)
    capture_cmd.add_argument("--generation", required=True)
    capture_cmd.add_argument("--previous-manifest", type=Path)
    verify_cmd = commands.add_parser("verify")
    verify_cmd.add_argument("directory", type=Path)
    promote_cmd = commands.add_parser("promote")
    promote_cmd.add_argument("--base", type=Path, required=True)
    promote_cmd.add_argument("--generation", required=True)
    prune_cmd = commands.add_parser("prune")
    prune_cmd.add_argument("--base", type=Path, required=True)
    prune_cmd.add_argument("--keep", type=int, default=4)
    args = parser.parse_args()
    if args.command == "capture":
        if args.output.exists() or args.output.is_symlink():
            raise FileExistsError(args.output)
        try:
            previous = json.loads(args.previous_manifest.read_text()) if args.previous_manifest else None
            result = capture(args.home, args.output, args.generation, previous)
        except BaseException:
            # A failed capture is never a candidate for publication.
            if args.output.is_dir() and not args.output.is_symlink():
                shutil.rmtree(args.output)
            raise
        print(json.dumps({"generation": result["generation"], "files": len(result["files"]), "deferred": len(result["deferred"]), "omittedActive": len(result["omittedActive"])}))
    elif args.command == "verify":
        result = verify(args.directory)
        print(json.dumps({"generation": result["generation"], "files": len(result["files"])}))
    elif args.command == "promote":
        result = promote(args.base, args.generation)
        print(f"Published {result.name}")
    else:
        print(f"Removed {prune(args.base, args.keep)} old generations")


if __name__ == "__main__":
    main()
