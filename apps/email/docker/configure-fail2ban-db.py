#!/usr/bin/env python3
"""Write fail2ban's private sidecar connection without replacing other SQL credentials."""

import os
from pathlib import Path
import re
import shlex
import sys
import tempfile


def write_private(path, content, root):
    if path.is_symlink() or not path.resolve().is_relative_to(root):
        raise ValueError("fail2ban database configuration must stay inside the mail filesystem")
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".openship-fail2ban-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as output:
            os.fchmod(output.fileno(), 0o600)
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    host = os.environ.get("OPENSHIP_MAIL_DB_HOST", "127.0.0.1")
    raw_port = os.environ.get("OPENSHIP_MAIL_DB_PORT", "5432")
    password = os.environ.get("VMAIL_DB_BIND_PASSWD", "")
    if not re.fullmatch(r"[A-Za-z0-9_.:%-]+", host):
        raise ValueError("OPENSHIP_MAIL_DB_HOST must be a TCP hostname or IP address")
    if not re.fullmatch(r"[0-9]+", raw_port.strip()) or not 1 <= int(raw_port) <= 65535:
        raise ValueError("OPENSHIP_MAIL_DB_PORT must be a decimal port between 1 and 65535")
    if not password or any(character in password for character in "\r\n\0"):
        raise ValueError("VMAIL_DB_BIND_PASSWD must be a non-empty single-line password")
    port = str(int(raw_port))
    # Only used by filesystem tests. Published connection paths remain absolute
    # inside the container, even when generation runs against a fixture root.
    root = Path(sys.argv[1] if len(sys.argv) > 1 else "/").resolve()
    config = root / "etc/fail2ban/openship-postgresql.conf"
    passfile = root / "etc/fail2ban/openship-postgresql.pgpass"
    escape = lambda value: value.replace("\\", "\\\\").replace(":", "\\:")
    credentials = f"{escape(host)}:{port}:fail2ban:fail2ban:{escape(password)}\n"
    settings = {
        "PGHOST": host,
        "PGPORT": port,
        "PGPASSFILE": "/etc/fail2ban/openship-postgresql.pgpass",
        "PGCONNECT_TIMEOUT": "5",
    }
    # Publish the password first, then the settings that refer to it. Fail2ban is
    # not started until this succeeds; every boot reconciles a changed SQL port.
    write_private(passfile, credentials, root)
    write_private(config, "".join(f"export {key}={shlex.quote(value)}\n" for key, value in settings.items()), root)
    print("[openship-mail] configured fail2ban's PostgreSQL sidecar connection")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        print(f"[openship-mail] FATAL: fail2ban database configuration failed: {error}", file=sys.stderr)
        sys.exit(1)
