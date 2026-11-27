"""Postfix pipe transport. Mail, envelope and SASL identity arrive as data only."""
import hashlib
import http.client
import json
import re
import sys
from email import policy
from email.parser import BytesParser
from pathlib import Path
from urllib.parse import urlsplit

CONFIG = Path("/etc/postfix/openship-api")
MAX_BYTES = 1024 * 1024
ADDRESS = re.compile(r"[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}", re.ASCII)


class InvalidMail(ValueError):
    pass


def address(value):
    if not isinstance(value, str) or len(value) > 254 or not ADDRESS.fullmatch(value):
        raise InvalidMail("Invalid mailbox address")
    return value


def header_addresses(message, field):
    values = message.get_all(field, [])
    if len(values) > 1 or any(header.defects for header in values):
        raise InvalidMail("Invalid address header")
    return [address(item.addr_spec) for header in values for item in header.addresses]


def submission(raw, login, sender, recipients, queue_id):
    sender = address(sender)
    if address(login).lower() != sender.lower():
        raise InvalidMail("Sender must match the authenticated mailbox")
    if len(raw) > MAX_BYTES or not 1 <= len(recipients) <= 50:
        raise InvalidMail("Mail exceeds relay limits")
    message = BytesParser(policy=policy.default).parsebytes(raw)
    if [s.lower() for s in header_addresses(message, "From")] != [sender.lower()]:
        raise InvalidMail("From must match the authenticated mailbox")
    if message.get("In-Reply-To") or message.get("References"):
        raise InvalidMail("Threading headers require a full MIME transport")
    if len(message.get_all("Subject", [])) != 1:
        raise InvalidMail("A subject is required")
    subject = str(message["Subject"])
    if not 1 <= len(subject) <= 998 or re.search(r"[\x00-\x1f\x7f]", subject):
        raise InvalidMail("Invalid subject")

    payload = {"from": sender, "subject": subject, "to": []}
    visible_to = {s.lower() for s in header_addresses(message, "To")}
    visible_cc = {s.lower() for s in header_addresses(message, "Cc")}
    # Only the accepted envelope may deliver. Unlisted recipients stay blind.
    for recipient in sorted(set(map(address, recipients))):
        field = "to" if recipient.lower() in visible_to else "cc" if recipient.lower() in visible_cc else "bcc"
        payload.setdefault(field, []).append(recipient)
    reply_to = header_addresses(message, "Reply-To")
    if len(reply_to) > 50:
        raise InvalidMail("Too many Reply-To addresses")
    if reply_to:
        payload["replyTo"] = reply_to

    parts = list(message.iter_parts()) if message.get_content_type() == "multipart/alternative" else [message]
    for part in parts:
        field = {"text/plain": "text", "text/html": "html"}.get(part.get_content_type())
        if not field or field in payload or part.get_filename() or part.get_content_disposition() == "attachment":
            raise InvalidMail("The API relay supports plain text and HTML without attachments")
        body = part.get_content()
        if part.defects or not isinstance(body, str) or len(body) > 250000:
            raise InvalidMail("Invalid or oversized body")
        if body:
            payload[field] = body
    if message.defects or not ("text" in payload or "html" in payload):
        raise InvalidMail("A text or HTML body is required")
    # Postfix retries the same queued bytes. Its Received stamp also distinguishes
    # a later submission of identical content if a short queue ID is recycled.
    digest = hashlib.sha256(raw)
    for item in [queue_id, json.dumps(payload, sort_keys=True)]:
        digest.update(item.encode("utf-8") + b"\0")
    payload["idempotencyKey"] = digest.hexdigest()
    return payload


def deliver(config, payload):
    url = urlsplit(config["apiOrigin"])
    if url.scheme == "https":
        client = http.client.HTTPSConnection(url.hostname, url.port, timeout=25)
    elif url.scheme == "http" and url.hostname in ("localhost", "127.0.0.1", "::1"):
        client = http.client.HTTPConnection(url.hostname, url.port, timeout=25)
    else:
        raise ValueError("Invalid configured Cloud origin")
    try:
        client.request("POST", "/api/mail/send", json.dumps(payload).encode(), {
            "Content-Type": "application/json", "Authorization": "Bearer " + config["key"],
        })
        res = client.getresponse()
        if res.status == 202:
            receipt = json.loads(res.read(16384))
            if isinstance(receipt, dict) and isinstance(receipt.get("id"), str) and receipt["id"]:
                if receipt.get("state") in ("failed", "bounced", "suppressed", "complained"):
                    raise InvalidMail("Cloud declined delivery")
                if receipt.get("state") in ("queued", "dispatching", "unknown", "accepted", "delivered", "delayed"):
                    return
        if res.status == 409:
            error = json.loads(res.read(16384))
            if error.get("code") == "mail_idempotency_conflict":
                raise InvalidMail("Cloud rejected the retry identity")
        if res.status in (400, 413, 422):
            raise InvalidMail("Cloud declined this message")
        raise OSError("Cloud relay unavailable")
    finally:
        client.close()


def main(args):
    binding, queue_id, login, sender, *recipients = args
    try:
        payload = submission(sys.stdin.buffer.read(MAX_BYTES + 1), login, sender, recipients, queue_id)
    except InvalidMail as error:
        print("5.6.0 " + str(error))
        return 65
    except (ValueError, TypeError, LookupError, RecursionError):
        print("5.6.0 Message or sender is unsupported by this API relay")
        return 65
    try:
        domain = sender.rsplit("@", 1)[1].lower()
        settings = json.loads((CONFIG / (domain + ".json")).read_text())
        if settings["binding"] != binding:
            print("5.7.1 Mailbox domain no longer belongs to this connection")
            return 77
        deliver(settings, payload)
        return 0
    except InvalidMail as error:
        print("5.6.0 " + str(error))
        return 65
    except Exception:
        # Postfix retries the same submission after ambiguous or temporary errors.
        print("4.3.0 OpenShip API relay temporarily unavailable")
        return 75


if __name__ == "__main__":
    import resource
    resource.setrlimit(resource.RLIMIT_AS, (192 << 20, 192 << 20))
    resource.setrlimit(resource.RLIMIT_CPU, (12, 12))
    sys.exit(main(sys.argv[1:]))
