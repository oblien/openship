/** The managed host image includes Python for its command/Docker transport.
 * Give commands real pipes even when the provider allocates a PTY: tar refuses
 * terminal output, and merged stderr would corrupt binary backup streams.
 * Length-framed bytes preserve both channels without buffering the whole job. */
export const CLOUD_EXEC_FRAMING = String.raw`
import fcntl, json, os, selectors, signal, subprocess, sys

prefix = b'\x1e' + sys.argv[2].encode('ascii')
def frame(channel, payload):
    data = prefix + channel + b':' + str(len(payload)).encode('ascii') + b'\x1f' + payload
    while data:
        data = data[os.write(1, data):]

lock_path = '/tmp/' + sys.argv[2] + 'lock'
with os.fdopen(os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600), 'r+') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    saved = lock.read()
    if saved and json.loads(saved).get('cancelled'):
        frame(b'x', b'143')
        sys.exit(0)
    process = subprocess.Popen(['sh', '-c', sys.argv[1]], stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True,
        env=dict(os.environ, _OPENSHIP_EXEC_OWNER=sys.argv[2]))
    with open('/proc/' + str(process.pid) + '/stat') as stat:
        start = stat.read().rsplit(')', 1)[1].split()[19]
    lock.seek(0)
    lock.truncate()
    json.dump({'pid': process.pid, 'start': start}, lock)
    lock.flush()
def terminate(signum, _frame):
    try:
        os.killpg(process.pid, signum)
    except ProcessLookupError:
        pass
signal.signal(signal.SIGTERM, terminate)
signal.signal(signal.SIGINT, terminate)
signal.signal(signal.SIGHUP, terminate)

streams = selectors.DefaultSelector()
streams.register(process.stdout, selectors.EVENT_READ, b'o')
streams.register(process.stderr, selectors.EVENT_READ, b'e')
try:
    while streams.get_map():
        for key, _ in streams.select():
            payload = os.read(key.fd, 32768)
            if payload:
                frame(key.data, payload)
            else:
                streams.unregister(key.fileobj)
                key.fileobj.close()
    status = process.wait()
    status = status if status >= 0 else min(255, 128 - status)
    frame(b'x', str(status).encode('ascii'))
finally:
    streams.close()
    if process.poll() is None:
        terminate(signal.SIGKILL, None)
        process.wait()
    # A cancelled marker remains a tombstone for a late creation request.
    with open(lock_path, 'r') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if not json.load(lock).get('cancelled'):
            os.unlink(lock_path)
`;

/** The provider's task kill currently stops only its wrapper. Stop this
 * command's process groups first and verify their exit before releasing the
 * operation. A per-command lock also covers cancellation before spawn. */
export const CLOUD_EXEC_CANCEL = String.raw`
import fcntl, json, os, signal, sys, time

owner = ('_OPENSHIP_EXEC_OWNER=' + sys.argv[1]).encode()
lock_path = '/tmp/' + sys.argv[1] + 'lock'
with os.fdopen(os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600), 'r+') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    saved = lock.read()
    saved = json.loads(saved) if saved else {}
    saved['cancelled'] = True
    lock.seek(0)
    lock.truncate()
    json.dump(saved, lock)
    lock.flush()
    session = saved.get('pid')
    if session:
        try:
            with open('/proc/' + str(session) + '/stat') as stat:
                if stat.read().rsplit(')', 1)[1].split()[19] != saved['start']:
                    session = None  # PID was reused after this command ended.
        except FileNotFoundError:
            pass  # Children can retain the session after its leader exits.
    deadline = time.monotonic() + 10
    while True:
        groups = set()
        for entry in os.scandir('/proc'):
            if not entry.name.isdigit():
                continue
            try:
                with open(entry.path + '/stat') as stat:
                    state = stat.read().rsplit(')', 1)[1].split()
                if int(state[3]) != session:
                    with open(entry.path + '/environ', 'rb') as env:
                        if owner not in env.read().split(b'\0'):
                            continue
                if state[0] != 'Z':
                    groups.add(int(state[2]))
            except (FileNotFoundError, ProcessLookupError):
                pass
        if not groups:
            break
        for group in groups:
            try:
                os.killpg(group, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if time.monotonic() >= deadline:
            raise RuntimeError('Command process groups did not stop')
        time.sleep(0.05)
print('stopped:' + sys.argv[1], flush=True)
`;

/** The provider owns the PTY. Register its isolated session before accepting
 * input so cancellation can fence a late terminal-create response too. */
export const CLOUD_TERMINAL_SHELL = String.raw`
import fcntl, json, os, sys

marker = sys.argv[1]
if os.getsid(0) != os.getpid():
    raise RuntimeError('The terminal did not receive an isolated session')
with os.fdopen(os.open('/tmp/' + marker + 'lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600), 'r+') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    saved = lock.read()
    if saved and json.loads(saved).get('cancelled'):
        sys.exit(143)
    with open('/proc/self/stat') as stat:
        start = stat.read().rsplit(')', 1)[1].split()[19]
    lock.seek(0)
    lock.truncate()
    json.dump({'pid': os.getpid(), 'start': start}, lock)
    lock.flush()
    os.environ['_OPENSHIP_EXEC_OWNER'] = marker
    # The open fd is close-on-exec; keep the cancellation lock until exec so
    # recovery cannot observe a gap between registration and shell creation.
    os.execvpe('/bin/sh', ['/bin/sh', '-i'], os.environ)
`;
