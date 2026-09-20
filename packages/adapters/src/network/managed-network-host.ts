/**
 * Host-local transaction runner. Secrets never leave this process. The durable
 * receipt, exclusive lock and systemd timer protect the network independently of
 * the controller. Package/init/firewall commands are supplied by their owners.
 */
export const MANAGED_NETWORK_HOST = String.raw`
import datetime, fcntl, hashlib, ipaddress, json, os, pathlib, re, shlex, shutil, subprocess, sys, time

def diagnostic(value, secrets=()):
    text = value.decode('utf-8', errors='replace') if isinstance(value, bytes) else str(value or '')
    # Redact before truncating so a cut cannot leave part of a credential behind.
    for secret in secrets:
        if secret:
            for part in [secret.strip()] + secret.splitlines():
                if part.strip(): text = text.replace(part.strip(), '[redacted]')
    text = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)
    text = re.sub(r'-----BEGIN[^\n]*PRIVATE KEY-----[\s\S]*?(?:-----END[^\n]*PRIVATE KEY-----|$)', '[redacted private key]', text)
    text = re.sub(r'(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{43}=(?![A-Za-z0-9+/=])', '[redacted key]', text)
    text = re.sub(r'(?i)([a-z][a-z0-9+.-]{0,15}://)[^\s/@]{1,512}@', r'\1[redacted]@', text)
    text = re.sub(r'(?im)((?:privatekey|presharedkey|password|token|secret|authorization)[\s\"\x27]*[:=])[^\n]*', r'\1 [redacted]', text)
    text = re.sub(r'[\x00-\x08\x0b-\x1f\x7f]', '', text)
    text = text.encode('utf-8', errors='replace').decode('utf-8').strip()
    return text[:1600] + (' … [truncated]' if len(text) > 1600 else '')

class HostCommandError(RuntimeError):
    def __init__(self, label, status, output='', code='MANAGED_NETWORK_COMMAND_FAILED', secrets=()):
        detail = diagnostic(output, secrets)
        super().__init__(label + ' ' + status + (': ' + detail if detail else '. No error output was returned.'))
        self.code = code

def command_label(args, label=None):
    # Shell snippets can contain configuration. Callers label their purpose instead.
    return label or ('Network shell command' if args[0] in ('sh', 'bash') else shlex.join(args))

def run(args, data=None, optional=False, label=None, secrets=()):
    name = command_label(args, label)
    secrets = (*secrets, data)
    try:
        result = subprocess.run(args, input=data, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    except subprocess.TimeoutExpired as error:
        raise HostCommandError(name, 'timed out after 30 seconds', error.stderr, 'MANAGED_NETWORK_COMMAND_TIMEOUT', secrets) from None
    except OSError as error:
        raise HostCommandError(name, 'could not start', error.strerror, 'MANAGED_NETWORK_COMMAND_UNAVAILABLE') from None
    if result.returncode and not optional:
        raise HostCommandError(name, 'failed (exit ' + str(result.returncode) + ')', result.stderr, secrets=secrets)
    return result.stdout if result.returncode == 0 else ''

def run_json(args, label=None):
    output = run(args, label=label)
    try: return json.loads(output)
    except json.JSONDecodeError as error:
        raise HostCommandError(command_label(args, label), 'returned invalid JSON', error.msg + ' at line ' + str(error.lineno), 'MANAGED_NETWORK_REPORT_INVALID') from None

def commands(items, label):
    for index, command in enumerate(items):
        run(['sh', '-c', command], label=label + ' (command ' + str(index + 1) + '/' + str(len(items)) + ')')

def read(path, fallback=None):
    return json.loads(path.read_text()) if path.exists() else fallback

def write(path, value):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.tmp')
    descriptor = os.open(str(temp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w') as file:
        file.write(value if isinstance(value, str) else json.dumps(value, sort_keys=True)); file.flush(); os.fsync(file.fileno())
    os.replace(str(temp), str(path))
    directory = os.open(str(path.parent), os.O_DIRECTORY)
    try: os.fsync(directory)
    finally: os.close(directory)

def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

def current_hash(base):
    config = read(base / 'network.json')
    if config is None: return None
    # Hash the secret locally as well: an out-of-band key edit invalidates approval,
    # but neither the key nor its separate hash is sent to the controller.
    key = (base / 'private.key').read_text() if (base / 'private.key').exists() else ''
    return digest([config, key])

def public_key(path):
    if not path.exists(): return None
    return run(['wg', 'pubkey'], path.read_text()).strip()

def check_kernel():
    modules = pathlib.Path('/lib/modules') / os.uname().release
    builtins = modules / 'modules.builtin'
    if not pathlib.Path('/sys/module/wireguard').exists() and not (builtins.exists() and 'wireguard' in builtins.read_text()) and not any(modules.glob('**/wireguard.ko*')):
        raise RuntimeError('This kernel does not provide WireGuard. Install the distribution’s WireGuard kernel support and reboot if required, then inspect again.')

def inspect(c, base):
    iface = c['interfaceName']; owned = read(base / 'network.json')
    check_kernel()
    # -4 hides links with no IPv4 address, including transport-only WireGuard
    # and colliding interfaces without an ownership receipt. Filter addresses below.
    links = run_json(['ip', '-d', '-j', 'addr', 'show'])
    own = next((link for link in links if link['ifname'] == iface), None)
    if own and (not owned or owned.get('managedId') != c['managedId'] or own.get('linkinfo', {}).get('info_kind') != 'wireguard'):
        raise RuntimeError('The proposed interface already exists without an OpenShip ownership receipt. Choose a new managed network.')
    interfaces = sorted([{
        'name': link['ifname'], 'mtu': link['mtu'], 'up': 'UP' in link.get('flags', []),
        'kind': link.get('linkinfo', {}).get('info_kind'),
        'addresses': sorted([{'address': a['local'], 'prefixLength': a['prefixlen']} for a in link.get('addr_info', []) if a.get('family') == 'inet'], key=lambda a: a['address'])
    } for link in links if link['ifname'] != iface], key=lambda link: link['name'])
    route_rows = run_json(['ip', '-j', '-4', 'route', 'show', 'table', 'all'])
    route_rows = [{key: route[key] for key in ('dst', 'gateway', 'dev', 'table', 'type', 'metric') if key in route} for route in route_rows if route.get('dev') != iface]
    route_rows.sort(key=lambda route: json.dumps(route, sort_keys=True))
    routes = [str(ipaddress.ip_network(route['dst'], strict=False)) for route in route_rows if route.get('dst') and route['dst'] != 'default']
    docker = []
    if shutil.which('docker'):
        networks = run(['docker', 'network', 'ls', '-q']).split()
        if networks:
            for network in run_json(['docker', 'network', 'inspect'] + networks, label='docker network inspect'):
                for item in network.get('IPAM', {}).get('Config') or []:
                    subnet = item.get('Subnet', '')
                    if subnet and ':' not in subnet: docker.append(str(ipaddress.ip_network(subnet, strict=False)))
    dns = []
    resolver = pathlib.Path('/etc/resolv.conf')
    if resolver.exists():
        for line in resolver.read_text().splitlines():
            parts = line.split()
            if len(parts) > 1 and parts[0] == 'nameserver' and ':' not in parts[1]: dns.append(parts[1])
    firewall = run(['sh', '-c', c['firewallInspect']], label='Inspect host firewall rules')
    if c.get('requireIptables') and shutil.which('iptables'):
        firewall = run(['iptables-save'], label='Inspect connection-policy firewall')
    chain_prefix = 'OSWG_' + c['managedId'][:16] + '_'
    if not owned and chain_prefix in firewall:
        raise RuntimeError('Owned firewall chain names are already in use without a network receipt.')
    # Counters and our own rules are not foreign configuration. Docker/admin edits are.
    firewall = '\n'.join(re.sub(r'\[\d+:\d+\]', '[0:0]', line) for line in firewall.splitlines() if not line.startswith('#') and chain_prefix not in line and c['managedId'] not in line)
    if c.get('requireIptables'):
        # Installing iptables may materialize empty ACCEPT tables. Only actual
        # foreign chains, rules and restrictive policies change the review hash.
        tables = []; current_table = ''; entries = []
        for line in firewall.splitlines() + ['COMMIT']:
            if line.startswith('*'): current_table = line; entries = []
            elif line == 'COMMIT':
                if entries: tables += [current_table] + entries
                entries = []
            elif line and not re.match(r'^:(INPUT|OUTPUT|FORWARD|PREROUTING|POSTROUTING) ACCEPT \[0:0\]$', line): entries.append(line)
        firewall = '\n'.join(tables)
    active_ports = []
    for filename in ('/proc/net/udp', '/proc/net/udp6'):
        for line in pathlib.Path(filename).read_text().splitlines()[1:]:
            active_ports.append(int(line.split()[1].split(':')[-1], 16))
    old_port = owned.get('listenPort') if owned else None
    if c['listenPort'] in active_ports and c['listenPort'] != old_port:
        raise RuntimeError('The WireGuard UDP port is already in use. Choose a different transport port for this server.')
    machine = pathlib.Path('/etc/machine-id')
    machine_id = machine.read_text().strip() if machine.exists() else ''
    fingerprint = digest([interfaces, route_rows, sorted(docker), sorted(dns), firewall, machine_id])
    transport = []
    for endpoint in c.get('transportEndpoints', []):
        path = run_json(['ip', '-j', '-4', 'route', 'get', endpoint])
        device = path[0].get('dev') if path else None
        transport += [link['mtu'] for link in interfaces if link['name'] == device]
    return {
        'fingerprint': fingerprint, 'interfaces': interfaces, 'routes': sorted(set(routes + docker)),
        'reservedIps': dns, 'configHash': current_hash(base),
        'publicKey': public_key(base / 'private.key') if shutil.which('wg') else None,
        'packages': ([] if shutil.which('wg') else ['wireguard-tools']) + (['iptables'] if c.get('requireIptables') and not shutil.which('iptables') else []),
        'transportMtu': min(transport) if transport else 1500,
    }

def down(base, config):
    if config is None: return
    iface = config['interfaceName']
    links = run_json(['ip', '-d', '-j', 'link', 'show'])
    link = next((item for item in links if item['ifname'] == iface), None)
    if link:
        if link.get('linkinfo', {}).get('info_kind') != 'wireguard':
            raise RuntimeError('The owned interface was replaced by a different interface. Automatic removal was stopped.')
        run(['ip', 'link', 'delete', 'dev', iface])
    commands(config['firewall']['down'], 'Remove owned network firewall rules')
    rules = run(['sh', '-c', config['firewall']['inspect']], label='Verify removal of owned firewall rules')
    if 'OSWG_' + config['managedId'][:16] + '_' in rules:
        raise RuntimeError('Owned firewall rules could not be removed. Restore the operation again after checking firewall access.')

def private_routes(config):
    iface = config['interfaceName']
    run(['ip', 'address', 'add', config['privateIp'] + '/32', 'dev', iface])
    for destination in config.get('routeCidrs', [peer['privateIp'] + '/32' for peer in config['peers']]):
        # add (never replace) refuses a foreign route instead of taking it over.
        run(['ip', '-4', 'route', 'add', destination, 'dev', iface, 'src', config['privateIp']])

def up(base, config):
    if config is None: return
    # Remove only this owned link and its dedicated rules before an idempotent apply.
    down(base, config)
    iface = config['interfaceName']
    run(['ip', 'link', 'add', 'dev', iface, 'type', 'wireguard'])
    key = (base / 'private.key').read_text().strip()
    text = '[Interface]\nPrivateKey = ' + key + '\nListenPort = ' + str(config['listenPort']) + '\n'
    for peer in config['peers']:
        text += '\n[Peer]\nPublicKey = ' + peer['publicKey'] + '\nAllowedIPs = ' + peer['privateIp'] + '/32\nEndpoint = ' + peer['endpoint'] + ':' + str(peer['listenPort']) + '\nPersistentKeepalive = 25\n'
    path = base / 'wireguard.conf'; write(path, text)
    run(['wg', 'setconf', iface, str(path)], secrets=(key,))
    commands(config['firewall']['up'], 'Configure managed network firewall rules')
    if config['firewall'].get('snapshot'):
        rules = run(['sh', '-c', config['firewall']['snapshot']], label='Verify owned connection-policy rules')
        write(base / 'firewall-state.json', {'config': digest(config['firewall']), 'rules': rules})
    run(['ip', 'link', 'set', 'dev', iface, 'mtu', str(config['mtu']), 'up'])
    # Keepalives exercise the actual reviewed UDP endpoints without assigning
    # private addresses or routes. The same receipt and timer own this stage.
    if not config.get('transportOnly'): private_routes(config)

def healthy(base, config):
    if config is None:
        if any(item['ifname'] == interface_name for item in run_json(['ip', '-j', 'link', 'show'])): return False
        rules = run(['sh', '-c', c['firewallInspect']], label='Verify absence of owned firewall rules')
        return 'OSWG_' + managed_id[:16] + '_' not in rules
    iface = config['interfaceName']
    link = next((item for item in run_json(['ip', '-d', '-j', 'addr', 'show']) if item['ifname'] == iface), None)
    if not link or 'UP' not in link.get('flags', []) or link.get('mtu') != config['mtu'] or link.get('linkinfo', {}).get('info_kind') != 'wireguard': return False
    if run(['wg', 'show', iface, 'public-key'], optional=True).strip() != public_key(base / 'private.key'): return False
    if run(['wg', 'show', iface, 'listen-port'], optional=True).strip() != str(config['listenPort']): return False
    peers = {}
    for line in run(['wg', 'show', iface, 'allowed-ips'], optional=True).splitlines():
        fields = line.split()
        if len(fields) < 2 or fields[0] in peers: return False
        peers[fields[0]] = set(fields[1:])
    if peers != {peer['publicKey']: {peer['privateIp'] + '/32'} for peer in config['peers']}: return False
    if config['firewall'].get('snapshot'):
        expected = read(base / 'firewall-state.json')
        if not expected or expected.get('config') != digest(config['firewall']): return False
        if run(['sh', '-c', config['firewall']['snapshot']], label='Check connection-policy drift') != expected.get('rules'): return False
    addresses = {(item.get('local'), item.get('prefixlen')) for item in link.get('addr_info', []) if item.get('family') == 'inet'}
    if config.get('transportOnly'): return not addresses
    if addresses != {(config['privateIp'], 32)}: return False
    # A live key exchange does not prove that the configured private network still
    # exists. Keep rollback armed if an address or route changes after its probes.
    routes = run_json(['ip', '-j', '-4', 'route', 'show', 'table', 'main'])
    return all(any(
        route.get('dst') in (destination, destination[:-3] if destination.endswith('/32') else destination) and
        route.get('dev') == iface and route.get('prefsrc') == config['privateIp'] and
        route.get('type', 'unicast') == 'unicast'
        for route in routes
    ) for destination in config.get('routeCidrs', [peer['privateIp'] + '/32' for peer in config['peers']]))

def unit_path(suffix):
    return pathlib.Path('/etc/systemd/system') / ('openship-network-' + managed_id + suffix)

def cancel_timer(receipt):
    commands([receipt['services']['cancelTimer']], 'Cancel network rollback timer')

def restore(base, receipt):
    if receipt['stage'] == 'rolled_back': return
    current = read(base / 'network.json')
    expected = receipt['afterHash'] if receipt.get('changed') else receipt['beforeHash']
    if receipt.get('phase') != 'writing' and current_hash(base) != expected:
        raise RuntimeError('The managed configuration changed outside this operation. Automatic rollback was stopped to preserve those edits.')
    down(base, current)
    before = read(base / 'before.json')
    if before is not None:
        write(base / 'network.json', before)
        write(base / 'private.key', (base / 'before.key').read_text())
        up(base, before)
        commands([receipt['services']['enable']], 'Enable restored network startup service')
    else:
        for name in ('network.json', 'private.key', 'wireguard.conf'):
            (base / name).unlink(missing_ok=True)
        commands([receipt['services']['disable']], 'Disable managed network startup service')
    receipt['stage'] = 'rolled_back'; receipt['afterHash'] = current_hash(base)
    write(base / 'receipt.json', receipt)
    cancel_timer(receipt)

def receipt_output(base, receipt):
    return {
        'operationId': receipt['operationId'], 'generation': receipt['generation'],
        'stage': receipt['stage'], 'deadline': receipt['deadline'],
        'publicKey': public_key(base / 'staged.key'),
        'configHash': current_hash(base), 'healthy': healthy(base, read(base / 'network.json')),
    }

try:
    action = sys.argv[1]; c = json.loads(sys.argv[2])
    if sys.version_info < (3, 8): raise RuntimeError('Managed networking requires Python 3.8 or newer.')
    managed_id = c['managedId']; interface_name = c['interfaceName']
    if not re.fullmatch('[a-f0-9]{32}', managed_id) or interface_name != 'oswg' + managed_id[:10]:
        raise RuntimeError('Invalid managed network identity.')
    base = pathlib.Path(c['stateDir']) / 'networks' / managed_id
    if action == 'prerequisites':
        check_kernel()
        run_json(['ip', '-j', '-4', 'addr', 'show'])
        print(json.dumps({'ready': True})); sys.exit(0)
    if action == 'inspect':
        print(json.dumps(inspect(c, base))); sys.exit(0)
    if action == 'ready':
        config = read(base / 'network.json')
        if not config: raise RuntimeError('The managed interface is not configured on this server.')
        deadline = time.monotonic() + min(30, max(0, c.get('waitSeconds', 30)))
        expected = set(peer['publicKey'] for peer in config['peers'])
        while True:
            handshakes = dict(line.split() for line in run(['wg', 'show', interface_name, 'latest-handshakes'], optional=True).splitlines())
            interface_ready = healthy(base, config)
            ready = interface_ready and all(int(handshakes.get(key, '0')) > 0 for key in expected)
            if ready or time.monotonic() >= deadline: break
            time.sleep(0.25)
        peers = []
        for peer in config['peers']:
            stamp = int(handshakes.get(peer['publicKey'], '0'))
            peers.append({
                'serverId': peer['serverId'], 'endpoint': peer['endpoint'], 'port': peer['listenPort'],
                'ok': stamp > 0,
                'lastHandshakeAt': datetime.datetime.fromtimestamp(stamp, datetime.timezone.utc).isoformat() if stamp > 0 else None,
            })
        print(json.dumps({'ready': ready, 'interfaceReady': interface_ready, 'peers': peers})); sys.exit(0)
    if action == 'status' and not base.exists():
        print(json.dumps({'missing': True})); sys.exit(0)
    base.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(base, 0o700)
    with open(base / 'lock', 'a') as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        receipt = read(base / 'receipt.json')
        if action == 'boot':
            if receipt and receipt['stage'] not in ('committed', 'rolled_back') and time.time() >= receipt['deadline']:
                restore(base, receipt)
            else: up(base, read(base / 'network.json'))
            print(json.dumps({'ok': True})); sys.exit(0)
        if action == 'timer':
            if receipt and receipt['operationId'] == c['operationId'] and receipt['generation'] == c['generation'] and receipt['stage'] not in ('committed', 'rolled_back') and time.time() >= receipt['deadline']:
                restore(base, receipt)
            print(json.dumps({'ok': True})); sys.exit(0)
        if action == 'prepare':
            observation = inspect(c, base)
            if observation['fingerprint'] != c['expectedFingerprint']:
                raise RuntimeError('The server network changed after review. Restore this operation and create a fresh plan.')
            same = receipt and receipt['operationId'] == c['operationId']
            if receipt and (receipt['generation'] > c['generation'] if same else receipt['stage'] not in ('committed', 'rolled_back')):
                raise RuntimeError('Another managed network operation owns this server.')
            if not same or receipt['stage'] == 'rolled_back':
                if observation['configHash'] != c['expectedConfigHash']:
                    raise RuntimeError('The managed network configuration changed after review. Create a new plan.')
                before = read(base / 'network.json')
                write(base / 'before.json', before)
                if before: write(base / 'before.key', (base / 'private.key').read_text())
                elif (base / 'before.key').exists(): (base / 'before.key').unlink()
                key = (base / 'private.key').read_text() if before and not c['rotateKeys'] else run(['wg', 'genkey'])
                write(base / 'staged.key', key)
                receipt = {
                    'operationId': c['operationId'], 'generation': c['generation'], 'stage': 'prepared',
                    'deadline': int(time.time()) + c['rollbackSeconds'], 'services': c['services'],
                    'beforeHash': observation['configHash'], 'afterHash': None,
                }
            else:
                if receipt.get('afterHash') and current_hash(base) != receipt['afterHash']:
                    raise RuntimeError('The owned network was edited outside this operation.')
                receipt.update(generation=c['generation'], deadline=int(time.time()) + c['rollbackSeconds'], stage='prepared')
            write(base / 'receipt.json', receipt)
            script = base / 'runner.py'; write(script, pathlib.Path(__file__).read_text() if '__file__' in globals() else c['runner'])
            common = {'managedId': managed_id, 'interfaceName': interface_name, 'stateDir': c['stateDir']}
            def exec_line(verb, data):
                # systemd does not use a shell. JSON is escaped as one argument, and
                # all identity/path fields are controlled by OpenShip.
                arg = json.dumps(data, separators=(',', ':')).replace('\\', '\\\\').replace('"', '\\"')
                return '/usr/bin/env python3 ' + str(script) + ' ' + verb + ' "' + arg + '"'
            write(unit_path('.service'), '[Unit]\nDescription=OpenShip managed private network\nAfter=network-online.target docker.service nftables.service netfilter-persistent.service\nWants=network-online.target\nStartLimitIntervalSec=0\n[Service]\nType=oneshot\nRemainAfterExit=yes\nRestart=on-failure\nRestartSec=10\nExecStart=' + exec_line('boot', common) + '\n[Install]\nWantedBy=multi-user.target\n')
            timer_data = dict(common, operationId=c['operationId'], generation=c['generation'])
            write(unit_path('-rollback.service'), '[Unit]\nDescription=Restore an uncommitted OpenShip network\nStartLimitIntervalSec=0\n[Service]\nType=oneshot\nRestart=on-failure\nRestartSec=10\nExecStart=' + exec_line('timer', timer_data) + '\n')
            deadline = datetime.datetime.fromtimestamp(receipt['deadline'], datetime.timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')
            write(unit_path('-rollback.timer'), '[Unit]\nDescription=OpenShip network rollback deadline\n[Timer]\nOnCalendar=' + deadline + '\nPersistent=true\nAccuracySec=1s\n[Install]\nWantedBy=timers.target\n')
            commands([c['services']['reload']], 'Reload network service definitions')
            commands([c['services']['armTimer']], 'Arm network rollback timer')
        elif action == 'status':
            if not receipt:
                print(json.dumps({'missing': True})); sys.exit(0)
        else:
            if action == 'rollback':
                if not receipt or receipt['operationId'] != c['operationId']:
                    # Missing journal files are not proof of cleanup: an orphaned
                    # interface/rule or a broken original network must keep its claim.
                    if current_hash(base) == c['expectedConfigHash'] and healthy(base, read(base / 'network.json')):
                        print(json.dumps({'missing': True})); sys.exit(0)
                    raise RuntimeError('The server no longer matches this operation or its original configuration.')
                if receipt['generation'] < c['generation']:
                    receipt['generation'] = c['generation']; write(base / 'receipt.json', receipt)
            if not receipt or receipt['operationId'] != c['operationId'] or receipt['generation'] != c['generation']:
                raise RuntimeError('This network operation is no longer the current host generation.')
            if action == 'rollback':
                restore(base, receipt)
            elif action == 'apply':
                if time.time() >= receipt['deadline'] or receipt['stage'] == 'rolled_back':
                    raise RuntimeError('The host rollback deadline passed. Resume to inspect and prepare this server again.')
                expected = receipt['afterHash'] if receipt.get('changed') else receipt['beforeHash']
                if receipt.get('phase') != 'writing' and current_hash(base) != expected:
                    raise RuntimeError('The managed configuration was changed outside this operation.')
                config = c.get('config')
                current = read(base / 'network.json')
                promote = current and current.get('transportOnly') and config and not config.get('transportOnly')
                if promote:
                    if {key: value for key, value in current.items() if key != 'transportOnly'} != config or not healthy(base, current):
                        raise RuntimeError('The verified WireGuard transport changed before private route setup. Restore this operation and review a new plan.')
                receipt['phase'] = 'writing'; write(base / 'receipt.json', receipt)
                if not promote: down(base, current)
                if config:
                    write(base / 'private.key', (base / 'staged.key').read_text())
                    write(base / 'network.json', config)
                    # Persist the new hash BEFORE the first potentially partial change.
                    receipt.update(afterHash=current_hash(base), changed=True, phase='configured'); write(base / 'receipt.json', receipt)
                    # Preserve the interface, keys and verified handshakes when
                    # promoting transport to a complete private network.
                    if promote: private_routes(config)
                    else: up(base, config)
                    if not config.get('transportOnly'):
                        commands([receipt['services']['enable']], 'Enable managed network startup service')
                else:
                    for name in ('network.json', 'private.key', 'wireguard.conf'):
                        (base / name).unlink(missing_ok=True)
                    receipt.update(afterHash=None, changed=True, phase='configured'); write(base / 'receipt.json', receipt)
                    commands([receipt['services']['disable']], 'Disable managed network startup service')
                receipt['stage'] = 'applied'; write(base / 'receipt.json', receipt)
            elif action == 'commit':
                if receipt['stage'] == 'committed':
                    print(json.dumps(receipt_output(base, receipt))); sys.exit(0)
                config = read(base / 'network.json')
                if config and config.get('transportOnly'):
                    raise RuntimeError('UDP transport alone cannot be committed. Private routes and connectivity must be configured and verified first.')
                if receipt['stage'] != 'applied' or time.time() >= receipt['deadline'] or current_hash(base) != receipt['afterHash'] or not healthy(base, config):
                    raise RuntimeError('This host no longer matches the verified network. Resume or restore the operation.')
                receipt['stage'] = 'committed'; write(base / 'receipt.json', receipt)
                cancel_timer(receipt)
            elif action == 'finalize':
                if receipt['stage'] not in ('committed', 'rolled_back'):
                    raise RuntimeError('The operation must settle before removing its recovery files.')
                for name in ('before.key', 'before.json', 'staged.key'):
                    (base / name).unlink(missing_ok=True)
            else: raise RuntimeError('Unknown managed network action.')
        print(json.dumps(receipt_output(base, receipt)))
except Exception as error:
    # Keep useful command errors while keys, stdin and shell configuration stay local.
    message = str(error) if isinstance(error, RuntimeError) else 'Network ' + action + ' failed (' + type(error).__name__ + '): ' + str(error)
    print(json.dumps({'error': diagnostic(message), 'code': getattr(error, 'code', 'MANAGED_NETWORK_HOST_FAILED')}))
    if action in ('boot', 'timer'): sys.exit(1)
`;
