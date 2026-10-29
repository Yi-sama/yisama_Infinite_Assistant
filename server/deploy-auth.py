"""Deploy the locally built authentication routes to the existing website service."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone

ROOT = Path("/opt/us-whitelist/releases/yisama-assistant-auth-20261029")
COMPOSE = Path("/opt/us-whitelist/runtime/new-api-bluegreen/accrual/compose.json")
PROJECT = "new-api-public-accrual"
SERVICE = "new-api-accrual"
OLD = "/opt/us-whitelist/releases/responses-terminal-20261028/new-api"
NEW = str(ROOT / "new-api")
STATE = ROOT / "deployment.json"


def run(args):
    result = subprocess.run(args, text=True, capture_output=True, timeout=150, check=False)
    if result.returncode:
        raise RuntimeError(f"{args[0]} failed: {result.stderr[:500]}")
    return result.stdout.strip()


def digest(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()


def private_json(file, data):
    temporary = file.with_suffix(file.suffix + ".tmp")
    temporary.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    temporary.chmod(0o600)
    os.replace(temporary, file)


def inspect(name):
    return json.loads(run(["docker", "inspect", name]))[0]


def compose_up():
    run(["docker", "compose", "-p", PROJECT, "-f", str(COMPOSE),
         "up", "-d", "--no-deps", "--pull", "never", SERVICE])


def http(path, body=None):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request("http://127.0.0.1:32840" + path, data=data, headers={
        "Host": "api.yisama.asia", "X-Forwarded-Proto": "https",
        "Content-Type": "application/json",
    })
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.load(response)


def wait_healthy():
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        current = inspect(SERVICE)
        if current["State"].get("Status") == "exited":
            raise RuntimeError("Website service exited.")
        if current["State"].get("Health", {}).get("Status") == "healthy":
            if http("/api/status").get("success") is True:
                return
        time.sleep(2)
    raise RuntimeError("Website service health check timed out.")


def rollback():
    state = json.loads(STATE.read_text())
    if digest(COMPOSE) != state["installed_compose_sha256"]:
        raise RuntimeError("Compose changed after deployment; refusing to overwrite newer changes.")
    backup = Path(state["compose_backup"])
    if digest(backup) != state["backup_sha256"]:
        raise RuntimeError("Compose backup checksum mismatch.")
    temporary = COMPOSE.with_suffix(".yisama-rollback.tmp")
    shutil.copy2(backup, temporary)
    os.replace(temporary, COMPOSE)
    compose_up()
    wait_healthy()
    state["status"] = "rolled_back"
    private_json(STATE, state)
    print(json.dumps({"rollback": "healthy", "binary": OLD}))


def deploy():
    if STATE.exists():
        raise RuntimeError("This release already has deployment state; inspect it before continuing.")
    manifest = json.loads((ROOT / "manifest.json").read_text())
    if digest(OLD) != manifest["baselineSha256"] or digest(NEW) != manifest["sha256"]:
        raise RuntimeError("Deployment binary checksum mismatch.")
    available = next(int(line.split()[1]) for line in Path("/proc/meminfo").read_text().splitlines()
                     if line.startswith("MemAvailable:"))
    if available < 512 * 1024:
        raise RuntimeError("Not enough available memory for a single-service replacement.")
    before = inspect(SERVICE)
    if before["Config"]["Labels"].get("com.docker.compose.project") != PROJECT:
        raise RuntimeError("Unexpected website Compose project.")
    if not any(m["Destination"] == "/new-api" and m["Source"] == OLD for m in before["Mounts"]):
        raise RuntimeError("Website binary changed since baseline verification.")
    original = COMPOSE.read_bytes()
    config = json.loads(original)
    if list(config["services"]) != [SERVICE]:
        raise RuntimeError("Unexpected services in the website Compose file.")
    mounts = [m for m in config["services"][SERVICE]["volumes"] if m.get("target") == "/new-api"]
    if len(mounts) != 1 or mounts[0]["source"] != OLD or not mounts[0]["read_only"]:
        raise RuntimeError("Unexpected website executable mount.")
    others = {}
    for name in run(["docker", "ps", "--format", "{{.Names}}"]).splitlines():
        if name != SERVICE:
            container = inspect(name)
            others[name] = [container["Id"], container["State"]["StartedAt"]]
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = COMPOSE.with_name(COMPOSE.name + ".before-yisama-assistant-auth-" + stamp)
    with backup.open("xb") as stream:
        stream.write(original)
    backup.chmod(0o600)
    mounts[0]["source"] = NEW
    installed = (json.dumps(config, indent=2) + "\n").encode()
    state = {
        "status": "prepared", "created_at": stamp, "compose_backup": str(backup),
        "backup_sha256": hashlib.sha256(original).hexdigest(),
        "installed_compose_sha256": hashlib.sha256(installed).hexdigest(),
        "binary_before": OLD, "binary_after": NEW, "candidate_sha256": manifest["sha256"],
        "other_containers": others,
    }
    private_json(STATE, state)
    temporary = COMPOSE.with_suffix(".yisama-auth.tmp")
    temporary.write_bytes(installed)
    temporary.chmod(0o600)
    os.replace(temporary, COMPOSE)
    try:
        compose_up()
        wait_healthy()
        options = http("/api/assistant/auth/options")
        if options.get("success") is not True:
            raise RuntimeError("Assistant authentication options failed.")
        for endpoint in ["/api/assistant/auth/login", "/api/assistant/auth/register"]:
            payload = http(endpoint, {})
            if payload.get("success") is not False or "turnstile" in str(payload).lower():
                raise RuntimeError("Assistant authentication route did not reject an empty request correctly.")
        website = http("/api/user/login", {})
        if website.get("success") is not False or "turnstile" not in str(website).lower():
            raise RuntimeError("Website CAPTCHA policy changed.")
        for name, identity in others.items():
            current = inspect(name)
            if [current["Id"], current["State"]["StartedAt"]] != identity:
                raise RuntimeError("An unrelated service changed during deployment.")
        state["status"] = "healthy"
        state["verified_at"] = datetime.now(timezone.utc).isoformat()
        private_json(STATE, state)
        print(json.dumps({
            "deployment": "healthy", "service": SERVICE,
            "assistant_options": options["data"], "website_captcha_preserved": True,
            "other_services_unchanged": True, "backup": str(backup),
        }))
    except Exception:
        rollback()
        raise


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in ["deploy", "rollback"]:
        raise SystemExit("Use deploy or rollback.")
    if sys.argv[1] == "deploy":
        deploy()
    else:
        rollback()
