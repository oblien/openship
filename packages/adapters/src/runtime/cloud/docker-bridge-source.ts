/** Runs inside the customer's workspace. The only upstream is its Docker socket.
 * Oblien authenticates the outer /proxy WebSocket; this listener stays on loopback.
 * Raw HTTP is carried inside WebSocket binary frames so Docker's exec/attach
 * upgrades and streaming archives work without exposing a Docker TCP port. */
export const CLOUD_DOCKER_BRIDGE_PORT = 23750;
export const CLOUD_DOCKER_BRIDGE_VERSION = "openship-docker-bridge-v2";
export const CLOUD_DOCKER_BRIDGE_SOURCE = String.raw`
import base64, hashlib, http.server, os, queue, socket, struct, threading

VERSION = "${CLOUD_DOCKER_BRIDGE_VERSION}"
MAX_FRAME = 8 * 1024 * 1024

class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path == "/health":
            body = VERSION.encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        key = self.headers.get("Sec-WebSocket-Key", "")
        if self.path != "/docker" or self.headers.get("Upgrade", "").lower() != "websocket" or not key:
            self.send_error(404)
            return
        upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            upstream.connect("/var/run/docker.sock")
        except OSError:
            upstream.close()
            self.send_error(503, "Docker is unavailable")
            return
        accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        self.send_response(101)
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        self.wfile.flush()
        write_lock = threading.Lock()
        closed = threading.Event()
        window = threading.Condition()
        credit = [262144]
        input_credit = [262144]
        writes = queue.Queue()

        def send(opcode, data=b""):
            length = len(data)
            head = bytes([0x80 | opcode])
            if length < 126:
                head += bytes([length])
            elif length <= 65535:
                head += bytes([126]) + struct.pack("!H", length)
            else:
                head += bytes([127]) + struct.pack("!Q", length)
            with write_lock:
                if closed.is_set():
                    return
                self.connection.sendall(head + data)
                if opcode == 8:
                    closed.set()

        def disconnect():
            closed.set()
            with window:
                window.notify_all()
            writes.put(None)
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

        def read_exact(length):
            data = self.rfile.read(length)
            if len(data) != length:
                raise EOFError()
            return data

        def receive_docker():
            try:
                while not closed.is_set():
                    with window:
                        while credit[0] <= 0 and not closed.is_set():
                            window.wait(timeout=30)
                        if closed.is_set():
                            break
                        limit = min(65536, credit[0])
                    data = upstream.recv(limit)
                    if not data:
                        # EOF only closes this direction. Keep receiving the
                        # request and WebSocket close handshake: shutting down
                        # TCP here can discard the buffered response on Linux.
                        send(1, b"eof")
                        return
                    with window:
                        credit[0] -= len(data)
                    send(2, data)
            except (OSError, EOFError):
                disconnect()

        def send_docker():
            try:
                while not closed.is_set():
                    data = writes.get()
                    if data is None:
                        upstream.shutdown(socket.SHUT_WR)
                        return
                    upstream.sendall(data)
                    with window:
                        input_credit[0] += len(data)
                    send(1, ("ack:" + str(len(data))).encode())
            except OSError:
                disconnect()

        threading.Thread(target=receive_docker, daemon=True).start()
        threading.Thread(target=send_docker, daemon=True).start()
        try:
            fragmented = False
            while not closed.is_set():
                first, second = read_exact(2)
                opcode, final = first & 15, bool(first & 128)
                length = second & 127
                if first & 112 or not second & 128:
                    raise ValueError("Invalid WebSocket frame")
                if length == 126:
                    length = struct.unpack("!H", read_exact(2))[0]
                elif length == 127:
                    length = struct.unpack("!Q", read_exact(8))[0]
                if length > MAX_FRAME or (opcode >= 8 and (length > 125 or not final)):
                    raise ValueError("Frame too large")
                mask = read_exact(4)
                data = bytes(value ^ mask[i % 4] for i, value in enumerate(read_exact(length)))
                if opcode == 8:
                    send(8, data)
                    break
                if opcode == 9:
                    send(10, data)
                    continue
                if opcode == 10:
                    continue
                if opcode == 1 and final and data == b"eof":
                    writes.put(None)
                    continue
                if opcode == 1 and final and data.startswith(b"ack:"):
                    amount = int(data[4:])
                    with window:
                        if amount <= 0 or credit[0] + amount > 262144:
                            raise ValueError("Invalid flow-control credit")
                        credit[0] += amount
                        window.notify()
                    continue
                if opcode == 2 and not fragmented:
                    fragmented = not final
                elif opcode == 0 and fragmented:
                    fragmented = not final
                else:
                    raise ValueError("Unexpected frame")
                # The websocket reader must stay free to receive flow-control
                # acknowledgements even when Docker stops reading its input.
                with window:
                    input_credit[0] -= len(data)
                    if input_credit[0] < 0:
                        raise ValueError("Input window exceeded")
                writes.put(data)
        except (OSError, EOFError, ValueError):
            pass
        finally:
            disconnect()
            try:
                upstream.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            upstream.close()
            self.close_connection = True

if __name__ == "__main__":
    # The daemon socket and listener can only be reached inside this workspace.
    os.umask(0o077)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 23750), Handler)
    server.daemon_threads = True
    server.serve_forever()
`;
