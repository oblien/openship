"""Offline submission sink. Record the authenticated payer only after accepting DATA."""
import json
import ssl
import threading
from aiosmtpd.controller import Controller
from aiosmtpd.smtp import AuthResult, LoginPassword

def authenticate(server, session, envelope, mechanism, credentials):
    valid = isinstance(credentials, LoginPassword) and (
        credentials.login, credentials.password
    ) in {(b"tenant-one", b"key-one"), (b"tenant-two", b"key-two")}
    return AuthResult(success=valid, handled=False, auth_data=credentials if valid else None)

class Relay:
    async def handle_DATA(self, server, session, envelope):
        with open("/tmp/receipts", "a") as stream:
            print(json.dumps([session.auth_data.login.decode(), envelope.mail_from, len(envelope.rcpt_tos)]), file=stream)
        return "250 Accepted"

tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
tls.load_cert_chain("/tmp/relay.crt", "/tmp/relay.key")
controller = Controller(Relay(), hostname="0.0.0.0", port=587, tls_context=tls,
                        authenticator=authenticate, auth_required=True, require_starttls=True)
controller.start()
threading.Event().wait()
