"""Install the authenticated submission transport. Called only by the worker."""
import fcntl
import pwd
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

POSTFIX = Path("/etc/postfix")
PRIVATE = POSTFIX / "openship-api"
ROUTES = POSTFIX / "openship-api-domains"
RELAY = "/opt/openship-mail/api-relay.py"


def atomic(path, content, mode, group=0):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as tmp:
        try:
            tmp.write(content)
            tmp.flush()
            os.fchown(tmp.fileno(), 0, group)
            os.fchmod(tmp.fileno(), mode)
            os.replace(tmp.name, path)
        finally:
            Path(tmp.name).unlink(missing_ok=True)


def command(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout.strip()


def relay_account(binding):
    if not re.fullmatch("[0-9a-f]{64}", binding):
        raise ValueError("Invalid installation binding")
    return "omr" + binding[:28]


def account_group(account):
    try:
        return pwd.getpwnam(account).pw_gid
    except KeyError:
        # A distinct UID/GID for each Cloud tenant isolates its relay processes
        # and key files. Logins and home directories have no role in delivery.
        command("useradd", "--system", "--no-create-home", "--user-group", "--no-log-init",
                "-K", "SYS_UID_MIN=50000", "-K", "SYS_UID_MAX=59999",
                "-K", "SYS_GID_MIN=50000", "-K", "SYS_GID_MAX=59999",
                "--home-dir", "/nonexistent", "--shell", "/usr/sbin/nologin", account)
        return pwd.getpwnam(account).pw_gid


def restore_accounts():
    # /etc/postfix persists independently of the container's passwd database.
    # Restore ownership before Postfix starts accepting or draining mail.
    for entry in PRIVATE.glob("*.json"):
        account = relay_account(json.loads(entry.read_text())["binding"])
        os.chown(entry, 0, account_group(account))
        os.chmod(entry, 0o640)


def routes():
    rows = []
    for entry in sorted(PRIVATE.glob("*.json")):
        binding = json.loads(entry.read_text())["binding"]
        rows.append("/@" + re.escape(entry.stem) + "$/ FILTER " + relay_account(binding) + ":" + binding)
    atomic(ROUTES, ("\n".join(rows) + "\n").encode(), 0o644)


def enable_transport(account):
    command("postconf", "-M", account + "/unix=" + account + " unix - n n - 8 pipe "
            "user=" + account + " argv=/usr/bin/python3 -I " + RELAY +
            " ${nexthop} ${queue_id} ${sasl_username} ${sender} ${recipient}")
    lookup = "check_sasl_access regexp:" + str(ROUTES)
    overrides = dict(line.split("=", 1) for line in command("postconf", "-P").splitlines() if "=" in line)
    for service in ("submission", "465"):
        param = service + "/inet/smtpd_end_of_data_restrictions"
        original = next((value.strip() for key, value in overrides.items() if key.strip() == param), None)
        if original is None:
            original = command("postconf", "-h", "smtpd_end_of_data_restrictions")
        setting = "openship_" + service + "_end_of_data"
        if original != "$" + setting:
            command("postconf", "-e", setting + "=" + lookup + (", " + original if original else ""))
            command("postconf", "-P", param + "=$" + setting)
    command("postconf", "-e", account + "_destination_recipient_limit=50")


def main(action, domain, *extra):
    if not re.fullmatch(r"(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+", domain):
        raise ValueError("Invalid domain")
    entry = PRIVATE / (domain + ".json")
    if action == "status":
        if not entry.exists():
            return None
        config = json.loads(entry.read_text())
        return {k: config[k] for k in ("binding", "keyId")}
    PRIVATE.mkdir(mode=0o711, exist_ok=True)
    os.chmod(PRIVATE, 0o711)
    previous = entry.read_bytes() if entry.exists() else None
    if action == "install":
        nonce, = extra
        if not re.fullmatch("[0-9a-f-]{36}", nonce):
            raise ValueError("Invalid staging file")
        raw = (POSTFIX / ("sasl_passwd.api-" + nonce)).read_bytes()
        config = json.loads(raw)
        if config["domain"] != domain or not re.fullmatch("[0-9a-f]{64}", config["binding"]):
            raise ValueError("Invalid credential binding")
        if previous and json.loads(previous)["binding"] != config["binding"]:
            raise ValueError("Remove the previous Cloud connection first")
        account = relay_account(config["binding"])
        group = account_group(account)
        enable_transport(account)
        atomic(entry, raw, 0o640, group)
    elif action == "remove":
        binding, = extra
        if previous and json.loads(previous)["binding"] != binding:
            raise ValueError("Cloud connection mismatch")
        entry.unlink(missing_ok=True)
    else:
        raise ValueError("Unknown operation")
    try:
        routes()
        command("postfix", "check")
        command("postfix", "reload")
    except Exception:
        if previous is None:
            entry.unlink(missing_ok=True)
        else:
            group = account_group(relay_account(json.loads(previous)["binding"]))
            atomic(entry, previous, 0o640, group)
        routes()
        raise
    return main("status", domain)


if __name__ == "__main__":
    with open("/run/openship-api-relay.lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if sys.argv[1:] == ["restore"]:
            restore_accounts()
        else:
            print(json.dumps(main(*sys.argv[1:])))
