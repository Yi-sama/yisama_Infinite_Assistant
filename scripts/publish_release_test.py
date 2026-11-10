import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import publish_release as publisher


def manifest(version="1.2.4", payload=b"MZisolated executable fixture"):
    return {"format": 1, "version": version, "url": "./Yisama-Setup-" + version + ".exe",
            "sha256": hashlib.sha256(payload).hexdigest(), "size": len(payload), "notes": "Test release"}


def wire(release, payload):
    return io.BytesIO(publisher.MAGIC + json.dumps(release).encode() + b"\n" + payload)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.payload = b"MZisolated executable fixture"
        self.release = manifest(payload=self.payload)

    def prepare_local(self):
        (self.root / "release").mkdir()
        (self.root / "package.json").write_text('{"version":"1.2.4"}', encoding="utf-8")
        files = self.root / "release"
        (files / "latest-1.2.4.json").write_text(json.dumps(self.release), encoding="utf-8")
        (files / "Yisama-Setup-1.2.4.exe").write_bytes(self.payload)
        (files / "Yisama-Setup-1.2.4.sha256").write_text(
            self.release["sha256"] + "  Yisama-Setup-1.2.4.exe\n", encoding="ascii")

    def test_bundle_checks_all_artifacts_before_writing(self):
        self.prepare_local()
        output = io.BytesIO()
        publisher.bundle(self.root, output)
        self.assertEqual(publisher.read_release(io.BytesIO(output.getvalue())), self.release)
        (self.root / "release/Yisama-Setup-1.2.4.exe").write_bytes(b"bad")
        output = io.BytesIO()
        with self.assertRaisesRegex(ValueError, "mismatch"):
            publisher.bundle(self.root, output)
        self.assertEqual(output.getvalue(), b"")

    def test_package_manifest_and_checksum_must_agree(self):
        self.prepare_local()
        file = self.root / "release/latest-1.2.4.json"
        file.write_text(json.dumps(manifest("1.2.5", self.payload)), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "versions differ"):
            publisher.local_release(self.root)
        file.write_text(json.dumps(self.release), encoding="utf-8")
        (self.root / "release/Yisama-Setup-1.2.4.sha256").write_text("wrong", encoding="ascii")
        with self.assertRaisesRegex(ValueError, "Checksum file"):
            publisher.local_release(self.root)

    def test_metadata_rejects_paths_invalid_versions_and_sizes(self):
        for change in [{"version": "../1"}, {"version": "1.02.3"}, {"url": "../installer.exe"},
                       {"url": "https://elsewhere.test/a.exe"}, {"sha256": "bad"},
                       {"size": True}, {"size": publisher.MAX_INSTALLER + 1}, {"format": True},
                       {"notes": "x" * 4001}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                publisher.validate(dict(self.release, **change))

    def test_protocol_rejects_oversized_metadata(self):
        with self.assertRaisesRegex(ValueError, "metadata length"):
            publisher.read_release(io.BytesIO(publisher.MAGIC + b"x" * (publisher.MAX_METADATA + 1)))
        with self.assertRaisesRegex(ValueError, "protocol"):
            publisher.read_release(io.BytesIO(b"not a release\n"))


@unittest.skipIf(os.name == "nt", "The production publisher uses Linux flock.")
class PublicationTests(ReleaseTests):
    def setUp(self):
        super().setUp()
        self.state = self.root / "state"
        self.state.mkdir()
        self.site = self.root / "site"
        self.site.mkdir()
        self.old_payload = b"MZprevious release"
        self.old = manifest("1.2.3", self.old_payload)
        self.original = json.dumps(self.old).encode()
        (self.site / "latest.json").write_bytes(self.original)
        (self.site / "Yisama-Setup-1.2.3.exe").write_bytes(self.old_payload)

    def publish(self, release=None, payload=None):
        return publisher.publish(self.site, self.state,
                                 wire(release or self.release, self.payload if payload is None else payload))

    def test_publish_then_repeat_preserves_old_files_and_latest_timestamp(self):
        result = self.publish()
        self.assertEqual(result["status"], "updated")
        self.assertEqual(Path(result["backup"]).read_bytes(), self.original)
        self.assertEqual((self.site / "Yisama-Setup-1.2.3.exe").read_bytes(), self.old_payload)
        self.assertEqual((self.site / "Yisama-Setup-1.2.4.exe").read_bytes(), self.payload)
        pointer = self.site / "latest.json"
        stamp = pointer.stat().st_mtime_ns
        self.assertEqual(self.publish()["status"], "unchanged")
        self.assertEqual(pointer.stat().st_mtime_ns, stamp)

    def test_bad_truncated_or_extra_bytes_leave_latest_unchanged(self):
        for payload in [b"x" * len(self.payload), self.payload[:-1], self.payload + b"extra"]:
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                self.publish(payload=payload)
            self.assertEqual((self.site / "latest.json").read_bytes(), self.original)
            self.assertFalse((self.site / "Yisama-Setup-1.2.4.exe").exists())
            self.assertEqual(list(self.site.glob(".incoming-*")), [])

    def test_older_and_changed_same_version_cannot_replace_current(self):
        self.publish()
        current = (self.site / "latest.json").read_bytes()
        for release, payload in [(self.old, self.old_payload), (manifest(payload=b"MZchanged"), b"MZchanged")]:
            with self.subTest(release=release), self.assertRaises(ValueError):
                self.publish(release, payload)
            self.assertEqual((self.site / "latest.json").read_bytes(), current)

    def test_conflicting_immutable_installer_or_checksum_stops_publication(self):
        for name in ["Yisama-Setup-1.2.4.exe", "Yisama-Setup-1.2.4.sha256"]:
            file = self.site / name
            file.write_bytes(b"conflict")
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.publish()
            self.assertEqual((self.site / "latest.json").read_bytes(), self.original)
            file.unlink()

    def test_pointer_write_failure_keeps_previous_release_and_can_resume(self):
        with mock.patch.object(publisher, "write_atomic", side_effect=OSError("isolated disk failure")):
            with self.assertRaises(OSError):
                self.publish()
        self.assertEqual((self.site / "latest.json").read_bytes(), self.original)
        self.assertEqual(self.publish()["status"], "updated")

    def test_parallel_publisher_cannot_take_the_lock(self):
        import fcntl
        with (self.state / "publish.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                self.publish()
        self.assertEqual((self.site / "latest.json").read_bytes(), self.original)


if __name__ == "__main__":
    unittest.main()
