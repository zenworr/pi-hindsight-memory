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

    def test_prune_keeps_current_and_prior_generation_only_when_importer_is_stopped(self):
        for name in ("generation-one", "generation-two", "generation-three"):
            publisher.capture(self.home, self.base / "incoming" / name, name)
            publisher.promote(self.base, name)
        original = publisher.assert_importer_stopped
        try:
            def running():
                raise RuntimeError("Stop the dev importer before pruning feed generations")
            publisher.assert_importer_stopped = running
            with self.assertRaisesRegex(RuntimeError, "Stop the dev importer"):
                publisher.prune(self.base, 2)
            self.assertTrue((self.base / "generations/generation-one").is_dir())
            publisher.assert_importer_stopped = lambda: None
            self.assertEqual(publisher.prune(self.base, 2), 1)
            self.assertFalse((self.base / "generations/generation-one").exists())
            self.assertTrue((self.base / "generations/generation-two").is_dir())
            self.assertEqual(publisher.verify(self.base / "current")["generation"], "generation-three")
        finally:
            publisher.assert_importer_stopped = original

    def test_active_writer_uses_the_previous_complete_record(self):
        previous = publisher.capture(self.home, self.base / "incoming" / "generation-one", "generation-one")
        old = publisher.promote(self.base, "generation-one")
        original = publisher.copy_file

        def changed_source(source, destination, expected):
            original(source, destination, expected)
            if source.name == "one.jsonl" and "pi/agent" in str(source):
                with source.open("a") as output:
                    output.write('{"id":"new"}\n')

        publisher.copy_file = changed_source
        try:
            result = publisher.capture(self.home, self.base / "incoming" / "generation-race", "generation-race", previous)
        finally:
            publisher.copy_file = original
        self.assertEqual(result["deferred"], ["pi/one.jsonl"])
        self.assertFalse((self.base / "incoming/generation-race/pi/one.jsonl").exists())
        published = publisher.promote(self.base, "generation-race")
        self.assertEqual(publisher.verify(published)["generation"], "generation-race")
        self.assertEqual(publisher.hash_file(old / "pi/one.jsonl"), publisher.hash_file(published / "pi/one.jsonl"))
        self.assertEqual((published / "pi/one.jsonl").stat().st_ino, (old / "pi/one.jsonl").stat().st_ino)

    def test_incomplete_new_session_is_omitted_until_complete(self):
        (self.home / publisher.SOURCES["pi"] / "one.jsonl").write_text('{"id":"active"}')
        result = publisher.capture(self.home, self.base / "incoming" / "generation-live", "generation-live")
        self.assertEqual(result["omittedActive"], ["pi/one.jsonl"])
        self.assertEqual(publisher.verify(self.base / "incoming/generation-live")["generation"], "generation-live")

    def test_malformed_complete_record_keeps_last_verified_generation(self):
        publisher.capture(self.home, self.base / "incoming" / "generation-one", "generation-one")
        old = publisher.promote(self.base, "generation-one")
        (self.home / publisher.SOURCES["pi"] / "one.jsonl").write_text('{not json}\n')
        with self.assertRaisesRegex(ValueError, "Malformed complete JSONL"):
            publisher.capture(self.home, self.base / "incoming" / "generation-bad", "generation-bad")
        self.assertEqual((self.base / "current").resolve(), old)

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
