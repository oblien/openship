"""Disposable IMAPS authentication fixture for smoke-catalog-radicale.ts.

Only implements the authentication exchange used by Radicale's built-in IMAP
backend. It never sends or stores mail and is not a production mail server.
"""

import base64
import json
import socketserver
import ssl
from pathlib import Path


class MailboxAuth(socketserver.StreamRequestHandler):
    def reply(self, message):
        self.wfile.write((message + "\r\n").encode())
        self.wfile.flush()

    def handle(self):
        self.request.settimeout(10)
        self.reply("* OK IMAPS smoke fixture")
        while line := self.rfile.readline(8192):
            tag, command, *_ = line.decode().strip().split()
            if command.upper() == "CAPABILITY":
                self.reply("* CAPABILITY IMAP4rev1 AUTH=PLAIN")
                self.reply(tag + " OK CAPABILITY")
            elif command.upper() == "AUTHENTICATE":
                self.reply("+")
                _, username, password = base64.b64decode(
                    self.rfile.readline(8192).strip()
                ).decode().split("\x00")
                accounts = json.loads(Path("/fixture/accounts.json").read_text())
                accepted = accounts.get(username) == password
                self.reply(tag + (" OK authenticated" if accepted else " NO denied"))
            elif command.upper() == "LOGOUT":
                self.reply("* BYE")
                self.reply(tag + " OK LOGOUT")
                break
            else:
                self.reply(tag + " BAD unsupported command")


class IMAPS(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def get_request(self):
        sock, address = super().get_request()
        try:
            return context.wrap_socket(sock, server_side=True), address
        except ssl.SSLError:
            sock.close()
            raise


context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain("/fixture/cert.pem", "/fixture/key.pem")
with IMAPS(("0.0.0.0", 993), MailboxAuth) as server:
    server.serve_forever()
