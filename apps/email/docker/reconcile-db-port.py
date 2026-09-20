#!/usr/bin/env python3
"""Reconcile SQL connection fields in the Debian mail image's daemon configs."""

import os
from pathlib import Path
import re
import stat
import sys
import tempfile


def replace_port(text, pattern, port):
    return re.sub(pattern, lambda match: match[1] + port, text, flags=re.MULTILINE)


def postfix(text, port):
    return replace_port(
        text, r"^([ \t]*hosts[ \t]*=[ \t]*(?:127\.0\.0\.1|localhost):)[0-9]+\b", port
    )


def dovecot(text, port):
    # Dovecot 2.3 (Debian 12) libpq connection strings. Match the connection
    # prefix, not arbitrary 'port=' text in passwords or listener blocks.
    return replace_port(
        text,
        r"^([ \t]*connect[ \t]*=[ \t]*host=(?:127\.0\.0\.1|localhost)[ \t]+port=)[0-9]+\b",
        port,
    )


def amavis(text, port):
    return replace_port(
        text,
        r"^([ \t]*@(?:storage|lookup)_sql_dsn[ \t]*=[ \t]*\([ \t]*\[[ \t]*['\"]DBI:Pg:database=[^;'\"\r\n]+;host=(?:127\.0\.0\.1|localhost);port=)[0-9]+\b",
        port,
    )


def iredapd(text, port):
    local = set(re.findall(
        r"^[ \t]*(vmail|amavisd|iredapd|iredadmin)_db_server[ \t]*=[ \t]*['\"](?:127\.0\.0\.1|localhost)['\"]",
        text, flags=re.MULTILINE,
    ))
    return re.sub(
        r"^([ \t]*(vmail|amavisd|iredapd|iredadmin)_db_port[ \t]*=[ \t]*)(['\"]?)[0-9]+\3(?=[ \t]*(?:#.*)?$)",
        lambda match: match[1] + match[3] + port + match[3] if match[2] in local else match[0],
        text, flags=re.MULTILINE,
    )


def reconcile(path, transform, port, root):
    if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(root):
        return False
    before = path.read_text()
    after = transform(before, port)
    if before == after:
        return False
    metadata = path.stat()
    fd, temporary = tempfile.mkstemp(prefix=".openship-db-port-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as output:
            owned = os.fstat(output.fileno())
            if (owned.st_uid, owned.st_gid) != (metadata.st_uid, metadata.st_gid):
                os.fchown(output.fileno(), metadata.st_uid, metadata.st_gid)
            os.fchmod(output.fileno(), stat.S_IMODE(metadata.st_mode))
            output.write(after)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return True


def main():
    raw = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("OPENSHIP_MAIL_DB_PORT", "5432")
    if not re.fullmatch(r"[0-9]+", raw.strip()) or not 1 <= int(raw) <= 65535:
        raise ValueError("OPENSHIP_MAIL_DB_PORT must be a decimal port between 1 and 65535")
    port = str(int(raw))
    # The optional root lets tests run the same script against actual iRedMail
    # sample configs without touching the developer's system configuration.
    root = Path(sys.argv[2] if len(sys.argv) > 2 else "/").resolve()
    for path in (root / "etc/postfix/pgsql").glob("*.cf"):
        reconcile(path, postfix, port, root)
    for path in (root / "etc/dovecot").rglob("*.conf"):
        reconcile(path, dovecot, port, root)
    for path in (root / "etc/amavis/conf.d").glob("*"):
        reconcile(path, amavis, port, root)
    settings = root / "opt/iredapd/settings.py"
    if reconcile(settings, iredapd, port, root):
        # Python's timestamp cache can otherwise survive a same-second change
        # between two ports with equal length. Never rewrite compiled bytecode.
        for cached in [settings.with_suffix(".pyc"), *(settings.parent / "__pycache__").glob("settings.*.pyc")]:
            if cached.resolve().is_relative_to(root):
                cached.unlink(missing_ok=True)
    print(f"[openship-mail] reconciled daemon SQL connections to port {port}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        print(f"[openship-mail] FATAL: database port reconciliation failed: {error}", file=sys.stderr)
        sys.exit(1)
