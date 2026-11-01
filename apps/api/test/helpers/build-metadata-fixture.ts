/** All addresses are added only to the disposable BuildKit worker's loopback.
 * This helper has no Docker socket, mounts or NET_ADMIN capability. Its replies
 * are fake receipts, never provider metadata or real credentials. */
export const BUILD_METADATA_FIXTURE = String.raw`
import http.server, socket, socketserver, struct, threading

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        receipt = b"OPENSHIP_MOCK_METADATA" if self.server.metadata else b"OPENSHIP_PACKAGE_OK"
        self.send_response(200)
        self.end_headers()
        self.wfile.write(receipt)
    def log_message(self, *args): pass

class IPv6HTTP(http.server.HTTPServer): address_family = socket.AF_INET6

for address, metadata, server_type in [
    ("169.254.169.254", True, http.server.HTTPServer),
    ("fd00:ec2::254", True, IPv6HTTP),
    ("fd20:ce::254", True, IPv6HTTP),
    ("198.18.0.1", False, http.server.HTTPServer),
]:
    server = server_type((address, 80), Handler)
    server.metadata = metadata
    threading.Thread(target=server.serve_forever, daemon=True).start()

class DNS(socketserver.BaseRequestHandler):
    def handle(self):
        data, sock = self.request
        if len(data) < 17: return
        end = 12
        while end < len(data) and data[end]: end += data[end] + 1
        if end + 5 > len(data): return
        question = data[12:end + 5]
        qtype = struct.unpack("!H", data[end + 1:end + 3])[0]
        answer = b""
        if qtype == 1:
            answer = b"\xc0\x0c\x00\x01\x00\x01\x00\x00\x00\x01\x00\x04" + socket.inet_aton("198.18.0.1")
        response = data[:2] + struct.pack("!5H", 0x8180, 1, bool(answer), 0, 0) + question + answer
        sock.sendto(response, self.client_address)

class IPv6UDP(socketserver.UDPServer): address_family = socket.AF_INET6
for address, server_type in [("169.254.169.254", socketserver.UDPServer), ("fd20:ce::254", IPv6UDP)]:
    server = server_type((address, 53), DNS)
    threading.Thread(target=server.serve_forever, daemon=True).start()
print("OPENSHIP_METADATA_FIXTURE_READY", flush=True)
threading.Event().wait()
`;
