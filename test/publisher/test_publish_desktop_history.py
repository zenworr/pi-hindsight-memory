import importlib.util
from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/publish-desktop-history.py"
SPEC = importlib.util.spec_from_file_location("desktop_publisher", SCRIPT)
publisher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(publisher)


class PublisherTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.home = self.root / "desktop"
        for relative in publisher.SOURCES.values():
            (self.home / relative).mkdir(parents=True)
            (self.home / relative / "one.jsonl").write_text('{"id":"one"}\n')
        for relative in publisher.DATABASES.values():
            file = self.home / relative
            file.parent.mkdir(parents=True, exist_ok=True)
            with closing(sqlite3.connect(file)) as database:
                database.execute("CREATE TABLE example(value TEXT)")
                database.execute("INSERT INTO example VALUES ('stable')")
                database.commit()
        self.base = self.root / "feed"
        self.base.mkdir(mode=0o700)
        (self.base / "incoming").mkdir(mode=0o700)

    def test_capture_verify_and_atomic_promotion(self):
        incoming = self.base / "incoming" / "generation-one"
        manifest = publisher.capture(self.home, incoming, "generation-one")
        self.assertEqual(manifest["origin"], "desktop")
        self.assertEqual(len(manifest["files"]), 5)
        self.assertEqual(publisher.verify(incoming)["generation"], "generation-one")
        published = publisher.promote(self.base, "generation-one")
        self.assertEqual((self.base / "current").resolve(), published)
        self.assertEqual(publisher.verify(self.base / "current")["generation"], "generation-one")
        for item in published.rglob("*.jsonl"):
            self.assertEqual(item.stat().st_mode & 0o777, 0o600)

    def test_database_backup_includes_uncheckpointed_wal(self):
        source = self.home / publisher.DATABASES["opencode"]
        with closing(sqlite3.connect(source)) as database:
            self.assertEqual(database.execute("PRAGMA journal_mode=WAL").fetchone(), ("wal",))
            database.execute("INSERT INTO example VALUES ('from WAL')")
            database.commit()
            incoming = self.base / "incoming" / "generation-wal"
            publisher.capture(self.home, incoming, "generation-wal")
            snapshot = incoming / "opencode" / "opencode.db"
            with closing(sqlite3.connect(snapshot)) as copy:
                self.assertEqual(copy.execute("SELECT value FROM example ORDER BY rowid DESC LIMIT 1").fetchone(), ("from WAL",))
            self.assertEqual(publisher.verify(incoming)["generation"], "generation-wal")

    def test_failed_new_generation_keeps_previous_one(self):
        publisher.capture(self.home, self.base / "incoming" / "generation-one", "generation-one")
        previous = publisher.promote(self.base, "generation-one")
        next_snapshot = self.base / "incoming" / "generation-two"
        publisher.capture(self.home, next_snapshot, "generation-two")
        (next_snapshot / "pi" / "one.jsonl").write_text("damaged")
        with self.assertRaises(RuntimeError):
            publisher.promote(self.base, "generation-two")
        self.assertEqual((self.base / "current").resolve(), previous)

    def test_source_change_during_capture_is_rejected(self):
        original = publisher.copy_file

        def changed_source(source, destination, expected):
            original(source, destination, expected)
            if source.name == "one.jsonl" and "pi/agent" in str(source):
                with source.open("a") as output:
                    output.write("new turn\n")

        publisher.copy_file = changed_source
        try:
            with self.assertRaisesRegex(RuntimeError, "changed during capture"):
                publisher.capture(self.home, self.base / "incoming" / "generation-race", "generation-race")
        finally:
            publisher.copy_file = original
        self.assertFalse((self.base / "current").exists())

    def test_reject_unexpected_files_and_symlinks(self):
        incoming = self.base / "incoming" / "generation-one"
        publisher.capture(self.home, incoming, "generation-one")
        (incoming / "extra.jsonl").write_text("other")
        with self.assertRaisesRegex(RuntimeError, "unexpected files"):
            publisher.verify(incoming)
        (incoming / "extra.jsonl").unlink()
        (incoming / "other").symlink_to(self.home, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, "symlinked directory"):
            publisher.verify(incoming)


if __name__ == "__main__":
    unittest.main()
