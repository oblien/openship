"""Keep Postfix and iRedAPD on the same explicit sender ownership query."""

import ast
from pathlib import Path
import re
import sys


LEGACY_QUERY = "SELECT mailbox.username FROM mailbox,domain WHERE mailbox.username='%s' AND mailbox.domain='%d' AND mailbox.domain=domain.domain AND mailbox.enablesmtp=1 AND mailbox.active=1 AND domain.backupmx=0 AND domain.active=1"
MARKER = "# Openship: share Postfix sender ownership, including active direct aliases."


def lookup_query(path):
    matches = re.findall(r"^query\s*=\s*(SELECT .+)$", Path(path).read_text(), re.MULTILINE)
    if len(matches) != 1:
        raise ValueError("Expected exactly one managed sender ownership query")
    return matches[0]


def upgrade_map(text, query):
    """Only upgrade the known old default; preserve connection fields/custom SQL."""
    return re.sub(
        r"^(query\s*=\s*)(.+)$",
        lambda match: match[1] + query if " ".join(match[2].split()) == LEGACY_QUERY else match[0],
        text, flags=re.MULTILINE,
    )


def patch_plugin(plugin, query):
    source = plugin.read_text()
    if MARKER in source:
        return
    # This is the pinned iRedAPD 6.1 per-user-alias branch, not a new plugin or
    # an allow-all mismatch setting. Fail the image build if upstream changes.
    original = re.compile(
        r'sql = """SELECT address\s+FROM forwardings\s+'
        r'WHERE address=%s AND \(forwarding=%s OR forwarding LIKE %s\) AND is_alias=1\s+'
        r'LIMIT 1""" % \(sqlquote\(sender\),\s+sqlquote\(real_sasl_username\),\s+'
        r"sqlquote\(real_sasl_username_user \+ '\+%%@' \+ sasl_username_domain\)\)"
    )
    shared = query.replace("'%s'", "{sqlquote(sender)}").replace("'%d'", "{sqlquote(sender_domain)}")
    replacement = MARKER + '\n                sql = f"""SELECT username FROM (' + shared + ') AS openship_sender_owners WHERE username={sqlquote(real_sasl_username)} LIMIT 1"""'
    updated, count = original.subn(lambda _: replacement, source)
    if count != 1:
        raise ValueError("Unsupported iRedAPD sender policy; review its per-user alias query")
    ast.parse(updated)
    plugin.write_text(updated)


if __name__ == "__main__":
    patch_plugin(Path(sys.argv[1]), lookup_query(sys.argv[2]))
