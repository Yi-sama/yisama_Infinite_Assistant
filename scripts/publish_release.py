"""Stream a verified Windows release to a restricted SSH publisher."""
import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile
from datetime import datetime, timezone
import urllib.parse
import urllib.request

MAGIC = b"YISAMA_RELEASE_V1\n"
MAX_METADATA = 16384
MAX_INSTALLER = 150 * 1024 * 1024
VERSION = re.compile(r"(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})")


def validate(value):
    if not isinstance(value, dict) or type(value.get("format")) is not int or value["format"] != 1:
        raise ValueError("Invalid release format")
    version = value.get("version", "")
    if not isinstance(version, str) or not VERSION.fullmatch(version):
        raise ValueError("Invalid release version")
    name = "Yisama-Setup-" + version + ".exe"
    if value.get("url") != "./" + name:
        raise ValueError("Installer URL must match the version")
    sha = value.get("sha256", "")
    if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{64}", sha):
        raise ValueError("Invalid release checksum")
    size = value.get("size")
    if type(size) is not int or not 2 <= size <= MAX_INSTALLER:
        raise ValueError("Invalid installer size")
    if not isinstance(value.get("notes", ""), str) or len(value.get("notes", "")) > 4000:
        raise ValueError("Invalid release notes")
    return name


def digest(file):
    result = hashlib.sha256()
    with file.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def local_release(root):
    version = json.loads((root / "package.json").read_text(encoding="utf-8"))["version"]
    if not isinstance(version, str) or not VERSION.fullmatch(version):
        raise ValueError("Invalid package version")
    file = root / "release" / ("latest-" + version + ".json")
    if file.stat().st_size > MAX_METADATA:
        raise ValueError("Release metadata is too large")
    release = json.loads(file.read_text(encoding="utf-8"))
    name = validate(release)
    if release["version"] != version:
        raise ValueError("Package and release versions differ")
    installer = root / "release" / name
    if installer.stat().st_size != release["size"] or digest(installer) != release["sha256"]:
        raise ValueError("Installer size or checksum mismatch")
    with installer.open("rb") as stream:
        if stream.read(2) != b"MZ":
            raise ValueError("Installer is not a Windows executable")
    checksum = root / "release" / name.replace(".exe", ".sha256")
    if checksum.read_text(encoding="ascii") != release["sha256"] + "  " + name + "\n":
        raise ValueError("Checksum file does not match the installer")
    return release, installer


def bundle(root, output):
    release, installer = local_release(root)
    metadata = json.dumps(release, ensure_ascii=True, separators=(",", ":")).encode("ascii") + b"\n"
    if len(metadata) > MAX_METADATA:
        raise ValueError("Release metadata is too large")
    output.write(MAGIC + metadata)
    with installer.open("rb") as stream:
        shutil.copyfileobj(stream, output, 1024 * 1024)


def read_release(stream):
    if stream.readline(len(MAGIC) + 1) != MAGIC:
        raise ValueError("Invalid publication protocol")
    metadata = stream.readline(MAX_METADATA + 1)
    if len(metadata) > MAX_METADATA or not metadata.endswith(b"\n"):
        raise ValueError("Invalid metadata length")
    release = json.loads(metadata)
    validate(release)
    return release


def write_atomic(file, data):
    descriptor, name = tempfile.mkstemp(prefix=".release-", dir=file.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.chmod(0o644)
        os.replace(temporary, file)
    finally:
        temporary.unlink(missing_ok=True)


def publish(root, state, source):
    import fcntl
    root = root.resolve(strict=True)
    state = state.resolve(strict=True)
    release = read_release(source)
    name = validate(release)
    latest = root / "latest.json"
    with (state / "publish.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        original = latest.read_bytes()
        current = json.loads(original)
        validate(current)
        incoming_version = tuple(map(int, release["version"].split(".")))
        current_version = tuple(map(int, current["version"].split(".")))
        if incoming_version < current_version:
            raise ValueError("Refusing to publish an older version")
        if incoming_version == current_version and (
            release["sha256"] != current["sha256"] or release["size"] != current["size"]
        ):
            raise ValueError("Refusing to replace an existing version")
        if shutil.disk_usage(root).free < release["size"] + 50 * 1024 * 1024:
            raise ValueError("Not enough disk space to stage the release")
        descriptor, temporary_name = tempfile.mkstemp(prefix=".incoming-", dir=root)
        temporary = Path(temporary_name)
        try:
            remaining = release["size"]
            checksum = hashlib.sha256()
            with os.fdopen(descriptor, "wb") as target:
                while remaining:
                    chunk = source.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise ValueError("Incomplete installer upload")
                    remaining -= len(chunk)
                    checksum.update(chunk)
                    target.write(chunk)
                target.flush()
                os.fsync(target.fileno())
            if source.read(1):
                raise ValueError("Unexpected bytes after installer")
            if checksum.hexdigest() != release["sha256"]:
                raise ValueError("Uploaded installer checksum mismatch")
            with temporary.open("rb") as target:
                if target.read(2) != b"MZ":
                    raise ValueError("Uploaded file is not a Windows executable")
            installer = root / name
            checksum_file = root / name.replace(".exe", ".sha256")
            checksum_bytes = (release["sha256"] + "  " + name + "\n").encode("ascii")
            if installer.exists():
                if installer.stat().st_size != release["size"] or digest(installer) != release["sha256"]:
                    raise ValueError("Existing immutable installer conflicts with release")
            if checksum_file.exists() and checksum_file.read_bytes() != checksum_bytes:
                raise ValueError("Existing checksum conflicts with release")
            if incoming_version == current_version:
                if not installer.exists() or not checksum_file.exists():
                    raise ValueError("Current release is incomplete")
                return {"status": "unchanged", "version": release["version"]}
            if latest.read_bytes() != original:
                raise ValueError("Release changed concurrently")
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
            backup = root / (".latest-before-" + release["version"] + "-" + stamp + ".json")
            with backup.open("xb") as stream:
                stream.write(original)
            backup.chmod(0o644)
            if not installer.exists():
                temporary.chmod(0o644)
                os.link(temporary, installer)
            if not checksum_file.exists():
                with checksum_file.open("xb") as stream:
                    stream.write(checksum_bytes)
                checksum_file.chmod(0o644)
            # The public pointer changes only after both immutable files are verified.
            write_atomic(latest, json.dumps(release, ensure_ascii=False, indent=2).encode("utf-8") + b"\n")
            return {"status": "updated", "version": release["version"], "sha256": release["sha256"],
                    "size": release["size"], "backup": str(backup)}
        finally:
            temporary.unlink(missing_ok=True)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Release redirects are not allowed")


def verify_public(root, url):
    expected, _ = local_release(root)
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.fragment:
        raise ValueError("Verification requires a plain HTTPS release URL")
    opener = urllib.request.build_opener(NoRedirect)
    with opener.open(url, timeout=45) as response:
        raw = response.read(MAX_METADATA + 1)
    if len(raw) > MAX_METADATA:
        raise ValueError("Public release metadata is too large")
    release = json.loads(raw)
    name = validate(release)
    if release["version"] != expected["version"] or release["sha256"] != expected["sha256"] or release["size"] != expected["size"]:
        raise ValueError("Public release does not match this commit")
    result = hashlib.sha256()
    total = 0
    with opener.open(urllib.parse.urljoin(url, name), timeout=45) as response:
        for chunk in iter(lambda: response.read(1024 * 1024), b""):
            total += len(chunk)
            if total > expected["size"]:
                raise ValueError("Public installer is too large")
            result.update(chunk)
    if total != expected["size"] or result.hexdigest() != expected["sha256"]:
        raise ValueError("Public installer verification failed")
    return {"status": "verified", "version": release["version"], "sha256": result.hexdigest(), "size": total}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["check", "bundle", "receive", "verify"])
    parser.add_argument("root", type=Path)
    parser.add_argument("target", nargs="?")
    args = parser.parse_args()
    if args.command == "check":
        release, _ = local_release(args.root)
        result = {"version": release["version"], "sha256": release["sha256"], "size": release["size"]}
    elif args.command == "bundle":
        bundle(args.root, sys.stdout.buffer)
        return
    elif args.command == "receive":
        if os.environ.get("SSH_ORIGINAL_COMMAND") != "publish-assistant-release":
            raise ValueError("Only publish-assistant-release is allowed")
        if not args.target:
            raise ValueError("A fixed server state directory is required")
        result = publish(args.root, Path(args.target), sys.stdin.buffer)
    else:
        if not args.target:
            raise ValueError("A public manifest URL is required")
        result = verify_public(args.root, args.target)
    print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("Release publication failed: " + str(error), file=sys.stderr)
        raise SystemExit(1)
