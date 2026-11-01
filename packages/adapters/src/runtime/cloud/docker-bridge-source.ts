/** Runs inside the customer's workspace. The only upstream is its Docker socket.
 * Oblien authenticates the outer /proxy WebSocket; this listener stays on loopback.
 * Raw HTTP is carried inside WebSocket binary frames so Docker's exec/attach
 * upgrades and streaming archives work without exposing a Docker TCP port. */
export const CLOUD_DOCKER_BRIDGE_PORT = 23750;
export const CLOUD_DOCKER_BRIDGE_VERSION = "openship-docker-bridge-v3";
export const CLOUD_DOCKER_BRIDGE_SOURCE = String.raw`
import base64, hashlib, http.client, http.server, io, json, os, queue, re, socket, struct, threading

VERSION = "${CLOUD_DOCKER_BRIDGE_VERSION}"
MAX_FRAME = 8 * 1024 * 1024
REQUESTS = "/opt/openship/cloud-docker/requests"
request_lock = threading.RLock()
active_requests = {}

def host_epoch():
    # PID namespace/init identity also works when a provider uses containers:
    # a new bridge process alone must never masquerade as a restarted server.
    with open("/proc/sys/kernel/random/boot_id") as f:
        boot = f.read().strip()
    with open("/proc/1/stat") as f:
        started = f.read().rsplit(")", 1)[1].split()[19]
    return boot + ":" + os.readlink("/proc/1/ns/pid") + ":" + started

EPOCH = host_epoch()

def durable_flag(name, content=""):
    os.makedirs(REQUESTS, mode=0o700, exist_ok=True)
    try:
        fd = os.open(os.path.join(REQUESTS, name), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        return False
    with os.fdopen(fd, "w") as f:
        f.write(content)
        f.flush()
        os.fsync(f.fileno())
    directory = os.open(REQUESTS, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    return True

def exists(name):
    return os.path.isfile(os.path.join(REQUESTS, name))

def recover_request(identity):
    with request_lock:
        # A late handshake/first write observes this before forwarding anything.
        durable_flag(identity + ".cancel")
        if exists(identity + ".done") or not exists(identity + ".pending"):
            return {"id": identity, "complete": True}
        with open(os.path.join(REQUESTS, identity + ".pending")) as f:
            epoch = f.read()
        if epoch != EPOCH:
            durable_flag(identity + ".done")
            return {"id": identity, "complete": True}
        disconnect = active_requests.get(identity)
        if disconnect:
            disconnect()
        return {"id": identity, "complete": False, "state": "pending" if disconnect else "unknown"}

class RequestBody:
    """Only framing is retained, never an archive or a command body."""
    def __init__(self, headers):
        lengths = [line.split(b":", 1)[1].strip() for line in headers if line.lower().startswith(b"content-length:")]
        encodings = [line.split(b":", 1)[1].strip().lower() for line in headers if line.lower().startswith(b"transfer-encoding:")]
        if len(lengths) > 1 or (lengths and encodings) or (encodings and encodings != [b"chunked"]):
            raise ValueError("Unsupported Docker request framing")
        self.remaining = int(lengths[0]) if lengths else 0
        if self.remaining < 0:
            raise ValueError("Invalid Docker content length")
        self.state = "size" if encodings else "length"
        self.line = bytearray()
        self.done = not encodings and self.remaining == 0

    def feed(self, data):
        offset = 0
        while offset < len(data) and not self.done:
            if self.state in ("length", "data"):
                size = min(self.remaining, len(data) - offset)
                self.remaining -= size
                offset += size
                if self.remaining == 0:
                    if self.state == "length":
                        self.done = True
                    else:
                        self.state = "separator"
                continue
            end = data.find(b"\n", offset)
            through = len(data) if end < 0 else end + 1
            self.line.extend(data[offset:through])
            offset = through
            if len(self.line) > 8192:
                raise ValueError("Docker chunk header too large")
            if end < 0:
                continue
            if not self.line.endswith(b"\r\n"):
                raise ValueError("Invalid Docker chunk")
            line = bytes(self.line[:-2])
            self.line.clear()
            if self.state == "size":
                size = line.split(b";", 1)[0]
                if not re.fullmatch(b"[0-9a-fA-F]+", size):
                    raise ValueError("Invalid Docker chunk size")
                self.remaining = int(size, 16)
                self.state = "data" if self.remaining else "trailers"
            elif self.state == "separator":
                if line:
                    raise ValueError("Invalid Docker chunk separator")
                self.state = "size"
            elif not line:
                self.done = True

class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *args):
        pass

    def do_POST(self):
        match = re.fullmatch(r"/recover/([a-f0-9-]{36})", self.path)
        if not match:
            self.send_error(404)
            return
        body = json.dumps(recover_request(match[1])).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def do_GET(self):
        if self.path == "/health":
            body = VERSION.encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        match = re.fullmatch(r"/docker/([a-f0-9-]{36})", self.path)
        identity = match[1] if match else None
        key = self.headers.get("Sec-WebSocket-Key", "")
        if (self.path != "/docker" and not identity) or self.headers.get("Upgrade", "").lower() != "websocket" or not key:
            self.send_error(404)
            return
        upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            upstream.connect("/var/run/docker.sock")
        except OSError:
            upstream.close()
            self.send_error(503, "Docker is unavailable")
            return
        if identity:
            with request_lock:
                if exists(identity + ".cancel") or not durable_flag(identity + ".pending", EPOCH):
                    upstream.close()
                    self.send_error(409, "Request already used or cancelled")
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
        mutation = [False]
        request_method = [None]
        request_ready = threading.Event()
        response_finished = threading.Event()
        request_body = [None]
        upgraded_request = [False]

        def completed():
            if identity:
                with request_lock:
                    durable_flag(identity + ".done")
                    active_requests.pop(identity, None)
            send(1, b"complete")

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
            request_ready.set()
            with window:
                window.notify_all()
            writes.put(None)
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

        if identity:
            with request_lock:
                active_requests[identity] = disconnect
                if exists(identity + ".cancel"):
                    disconnect()

        def read_exact(length):
            data = self.rfile.read(length)
            if len(data) != length:
                raise EOFError()
            return data

        def forward_response(data):
            offset = 0
            while offset < len(data) and not closed.is_set():
                with window:
                    while credit[0] <= 0 and not closed.is_set():
                        window.wait(timeout=30)
                    if closed.is_set():
                        return
                    size = min(65536, credit[0], len(data) - offset)
                    credit[0] -= size
                send(2, data[offset:offset + size])
                offset += size

        class ResponseBytes(io.RawIOBase):
            def readable(self):
                return True
            def readinto(self, target):
                size = upstream.recv_into(target)
                if size:
                    try:
                        forward_response(bytes(memoryview(target)[:size]))
                    except OSError:
                        # A lost controller does not cancel a daemon mutation.
                        disconnect()
                return size

        class ResponseSocket:
            def makefile(self, _mode):
                return io.BufferedReader(ResponseBytes(), 65536)

        def receive_docker():
            try:
                # Parse without rewriting raw response bytes. HTTPResponse
                # verifies lengths/chunks; EOF alone is not a completed request.
                request_ready.wait()
                response = http.client.HTTPResponse(ResponseSocket(), method=request_method[0])
                response.begin()
                if response.status == 101:
                    # Keep Docker's exec channel open until its process exits.
                    # Closing only stdin still allows the response to drain.
                    while response.fp.read1(65536):
                        pass
                else:
                    while response.read(65536):
                        pass
                completed()
                send(1, b"eof")
            except (OSError, EOFError, http.client.HTTPException):
                # Read-only or undispatched requests cannot leave a mutation.
                if not mutation[0]:
                    completed()
                disconnect()
            finally:
                response_finished.set()
                if identity:
                    with request_lock:
                        active_requests.pop(identity, None)
                if closed.is_set():
                    upstream.close()

        def send_docker():
            header = bytearray()
            started = False
            try:
                while True:
                    data = writes.get()
                    if data is None:
                        # A fully delivered HTTP request can finish without its
                        # controller. Half-closing would cancel that handler on
                        # some daemons even though it already began mutating.
                        if upgraded_request[0] or not request_body[0] or not request_body[0].done:
                            upstream.shutdown(socket.SHUT_WR)
                        return
                    if closed.is_set():
                        continue
                    if not started:
                        header.extend(data)
                        if len(header) > 65536 and b"\r\n\r\n" not in header[:65536]:
                            raise ValueError("Docker request headers too large")
                        if b"\r\n\r\n" not in header:
                            # Acknowledge buffered headers so partial frames
                            # never exhaust the input window before dispatch.
                            with window:
                                input_credit[0] += len(data)
                            send(1, ("ack:" + str(len(data))).encode())
                            continue
                        head, body = bytes(header).split(b"\r\n\r\n", 1)
                        lines = head.split(b"\r\n")
                        method = lines[0].split(b" ", 1)[0]
                        request_method[0] = method.decode("ascii")
                        upgrade = any(line.lower().startswith(b"upgrade:") for line in lines[1:])
                        upgraded_request[0] = upgrade
                        request_body[0] = RequestBody(lines[1:])
                        request_body[0].feed(body)
                        if not upgrade:
                            # One request per tunnel makes a response's lifetime
                            # independent of the client's keep-alive pool.
                            lines = [line for line in lines if not line.lower().startswith(b"connection:")]
                            lines.append(b"Connection: close")
                        with request_lock:
                            if identity and exists(identity + ".cancel"):
                                completed()
                                disconnect()
                                upstream.shutdown(socket.SHUT_WR)
                                return
                            mutation[0] = method not in (b"GET", b"HEAD", b"OPTIONS")
                            request_ready.set()
                        upstream.sendall(b"\r\n".join(lines) + b"\r\n\r\n" + body)
                        started = True
                        header.clear()
                    else:
                        request_body[0].feed(data)
                        upstream.sendall(data)
                    with window:
                        input_credit[0] += len(data)
                    send(1, ("ack:" + str(len(data))).encode())
            except (OSError, ValueError):
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
            if not identity or not mutation[0] or response_finished.is_set():
                try:
                    upstream.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                upstream.close()
            # A tracked mutation keeps its daemon reader after controller loss.
            # If the bridge itself dies, the pending journal survives and a
            # retry stays fenced until completion or a verified server restart.
            self.close_connection = True

if __name__ == "__main__":
    # The daemon socket and listener can only be reached inside this workspace.
    os.umask(0o077)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 23750), Handler)
    server.daemon_threads = True
    server.serve_forever()
`;
