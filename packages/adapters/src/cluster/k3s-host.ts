/** Host actions are fenced by ownership and a local flock. No credentials in command arguments. */
export const K3S_HOST = String.raw`
import fcntl, hashlib, ipaddress, json, os, pathlib, re, shutil, socket, subprocess, sys, tempfile, time, urllib.parse, urllib.request

ROOT = pathlib.Path('/var/lib/openship/k3s')
OWNER = ROOT / 'owner.json'
CONFIG = pathlib.Path('/etc/rancher/k3s/config.yaml')
BIN = pathlib.Path('/usr/local/bin/k3s')
DATA = pathlib.Path('/var/lib/rancher/k3s')
ACTION = sys.argv[1]
C = json.loads(sys.argv[2])

class NotEmptyError(RuntimeError): pass

def digest_file(path):
    digest = hashlib.sha256()
    with pathlib.Path(path).open('rb') as stream:
        while True:
            chunk = stream.read(1024 * 1024)
            if not chunk: break
            digest.update(chunk)
    return digest.hexdigest()

def run(args, timeout=30):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        detail = (result.stderr or result.stdout)[-2400:]
        detail = re.sub(r'K10[a-zA-Z0-9:]+', '[redacted]', detail)
        raise RuntimeError(args[0] + ' failed: ' + detail.strip())
    return result.stdout

def atomic(path, content, mode=0o600):
    path = pathlib.Path(path)
    if path.is_symlink(): raise RuntimeError('Refusing a symlink at ' + str(path))
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, name = tempfile.mkstemp(dir=str(path.parent), prefix='.openship-')
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(content.encode() if isinstance(content, str) else content)
            stream.flush(); os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name): os.unlink(name)

def owner():
    if ROOT.is_symlink() or OWNER.is_symlink(): raise RuntimeError('The runtime ownership directory is not a regular directory.')
    if not OWNER.exists(): return None
    value = json.loads(OWNER.read_text())
    if value.get('id') != C['id']: raise RuntimeError('This host belongs to a different OpenShip runtime. Its installation was left untouched.')
    return value

def guard(value):
    if time.time() > C['deadline']: raise RuntimeError('This setup command expired. Retry the saved operation.')
    if value and value.get('generation', 0) > C['generation']: raise RuntimeError('A newer setup attempt owns this host.')
    if value and value.get('nodeName') != C['host']['nodeName']: raise RuntimeError('The saved runtime identity changed.')

def foreign():
    # The upstream uninstaller owns global CNI/Kubernetes paths. Never adopt those implicitly.
    for path in [str(BIN), '/usr/bin/k3s', str(CONFIG.parent), str(DATA), '/usr/local/bin/k3s-uninstall.sh', '/usr/local/bin/k3s-agent-uninstall.sh', '/usr/local/bin/k3s-killall.sh', '/etc/kubernetes', '/var/lib/kubelet', '/var/lib/cni', '/etc/cni/net.d', '/etc/rancher/rke2', '/var/lib/rancher/rke2', '/var/lib/k0s', '/var/snap/microk8s']:
        if os.path.lexists(path): raise RuntimeError('An existing Kubernetes or CNI installation uses ' + path + '. OpenShip will not replace it.')
    for unit in pathlib.Path('/etc/systemd/system').glob('k3s*.service'):
        raise RuntimeError('An existing K3s service is installed: ' + unit.name)
    for chain in ['OSHIP-K3S-IN', 'OSHIP-K3S-OUT']:
        if subprocess.run(['iptables', '-w', '5', '-S', chain], capture_output=True).returncode == 0:
            raise RuntimeError('An unowned firewall chain already uses ' + chain + '. Inspect it before setting up this runtime.')

def links(): return json.loads(run(['ip', '-j', 'addr', 'show']))

def dns_ranges(paths=None):
    # A loopback stub in /etc/resolv.conf hides the real upstream private addresses.
    paths = paths or ['/etc/resolv.conf', '/run/systemd/resolve/resolv.conf', '/run/NetworkManager/resolv.conf', '/run/resolvconf/resolv.conf']
    ranges = []
    for name in paths:
        path = pathlib.Path(name)
        if not path.is_file(): continue
        for line in path.read_text().splitlines():
            fields = line.split()
            if len(fields) >= 2 and fields[0] == 'nameserver':
                try:
                    ip = ipaddress.ip_address(fields[1])
                    if ip.version == 4: ranges.append(str(ip) + '/32')
                except ValueError: pass
    return ranges

def inspect():
    value = owner()
    if value: guard(value)
    else: foreign()
    if not pathlib.Path('/run/systemd/system').is_dir(): raise RuntimeError('K3s setup requires systemd on the host.')
    if len(pathlib.Path('/proc/swaps').read_text().strip().splitlines()) > 1:
        raise RuntimeError('Swap is enabled. Disable swap on this server before setting up Kubernetes; OpenShip will not change memory settings used by existing workloads.')
    memory = int(re.search(r'MemTotal:\s+(\d+)', pathlib.Path('/proc/meminfo').read_text()).group(1)) * 1024
    required = 1800 * 1024**2 if C['host']['role'] == 'server' else 900 * 1024**2
    if memory < required or (os.cpu_count() or 0) < (2 if C['host']['role'] == 'server' else 1):
        raise RuntimeError('Control servers need at least 2 CPUs and 2 GB RAM; workers need at least 1 CPU and 1 GB RAM.')
    if shutil.disk_usage('/var/lib').free < 5 * 1024**3: raise RuntimeError('At least 5 GB of free disk space is required for the runtime.')
    cg = pathlib.Path('/sys/fs/cgroup/cgroup.controllers')
    # The kubelet refuses cgroup v1 hosts, so K3s would crash-loop after install.
    if not cg.exists(): raise RuntimeError('This server boots with cgroup v1, which Kubernetes no longer supports. Set systemd.unified_cgroup_hierarchy=1 on the kernel command line (remove any =0 setting), reboot, then retry.')
    if not {'memory', 'pids'}.issubset(set(cg.read_text().split())): raise RuntimeError('Enable memory and process cgroup controllers before setup.')
    nics = links()
    matched = [nic for nic in nics if any(addr.get('local') == C['host']['privateIp'] for addr in nic.get('addr_info', []))]
    if len(matched) != 1 or 'UP' not in matched[0].get('flags', []) or matched[0].get('mtu', 0) < 1280:
        raise RuntimeError('The saved private address needs an active interface with an MTU of at least 1280.')
    if not value:
        if any(nic['ifname'] in ['cni0', 'flannel.1', 'kube-ipvs0'] for nic in nics): raise RuntimeError('An existing container network conflicts with Kubernetes networking.')
        for protocol, port in [('udp', 8472), ('tcp', 10250)] + ([('tcp', 6443), ('tcp', 2379), ('tcp', 2380)] if C['host']['role'] == 'server' else []):
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM if protocol == 'udp' else socket.SOCK_STREAM) as sock:
                try: sock.bind(('0.0.0.0', port))
                except OSError: raise RuntimeError('Port ' + str(port) + '/' + protocol.upper() + ' is already in use. Resolve the conflict before setup.')
    ranges = []
    for nic in nics:
        if value and nic['ifname'] in ['cni0', 'flannel.1']: continue
        for addr in nic.get('addr_info', []):
            if addr.get('family') == 'inet': ranges.append(str(ipaddress.ip_network(addr['local'] + '/' + str(addr['prefixlen']), strict=False)))
    for route in json.loads(run(['ip', '-j', '-4', 'route', 'show', 'table', 'all'])):
        if value and route.get('dev') in ['cni0', 'flannel.1']: continue
        if route.get('dst') and route['dst'] not in ['default', '0.0.0.0/0']: ranges.append(str(ipaddress.ip_network(route['dst'], strict=False)))
    ranges.extend(dns_ranges())
    if shutil.which('docker') and subprocess.run(['systemctl', 'is-active', '--quiet', 'docker']).returncode == 0:
        ids = run(['docker', 'network', 'ls', '-q']).split()
        if ids:
            for net in json.loads(run(['docker', 'network', 'inspect'] + ids)):
                # Docker's host/none networks report Config: null, not an empty list.
                ranges.extend(cfg['Subnet'] for cfg in (net.get('IPAM', {}).get('Config') or []) if cfg.get('Subnet') and ':' not in cfg['Subnet'])
    return {'interfaceName': matched[0]['ifname'], 'ranges': sorted(set(ranges)), 'installed': value is not None}

def fetch(url, max_bytes):
    with urllib.request.urlopen(url, timeout=30) as response:
        if not response.url.startswith('https://'): raise RuntimeError('An insecure download redirect was refused.')
        content = response.read(max_bytes + 1)
        if len(content) > max_bytes: raise RuntimeError('Download exceeded its size limit.')
        return content

def claim():
    value = owner()
    guard(value)
    if not value:
        foreign()
        value = {'id': C['id'], 'generation': C['generation'], 'nodeName': C['host']['nodeName'], 'role': C['host']['role'], 'privateIp': C['host']['privateIp'], 'version': C['version'], 'podCidr': C['podCidr'], 'serviceCidr': C['serviceCidr']}
    for key in ['version', 'podCidr', 'serviceCidr']:
        if value.get(key) != C[key]: raise RuntimeError('The saved runtime configuration changed. This setup cannot replace an existing cluster.')
    if value['role'] != C['host']['role'] or value['privateIp'] != C['host']['privateIp']: raise RuntimeError('The saved server role or private address changed.')
    value['generation'] = C['generation']
    atomic(OWNER, json.dumps(value))
    return value

def binary():
    version = C['version']
    if not re.fullmatch(r'v1\.\d+\.\d+\+k3s\d+', version): raise RuntimeError('Invalid K3s release.')
    arch = os.uname().machine
    name, archname = ('k3s', 'amd64') if arch == 'x86_64' else ('k3s-arm64', 'arm64') if arch in ['aarch64', 'arm64'] else (None, None)
    if not name: raise RuntimeError('Only amd64 and arm64 servers are supported.')
    base = 'https://github.com/k3s-io/k3s/releases/download/' + urllib.parse.quote(version, safe='') + '/'
    sums = fetch(base + 'sha256sum-' + archname + '.txt', 65536).decode()
    expected = next((line.split()[0] for line in sums.splitlines() if len(line.split()) == 2 and line.split()[1].lstrip('*') == name), None)
    if not expected or not re.fullmatch('[a-f0-9]{64}', expected): raise RuntimeError('The release has no valid checksum for this server.')
    if BIN.exists():
        digest = digest_file(BIN)
        if digest != expected: raise RuntimeError('The installed K3s binary differs from the saved release. Automatic replacement was refused.')
    else:
        # Stage on the destination filesystem so separate /var and /usr mounts also work.
        BIN.parent.mkdir(parents=True, exist_ok=True)
        fd, path = tempfile.mkstemp(dir=str(BIN.parent), prefix='.openship-k3s-')
        try:
            digest = hashlib.sha256(); total = 0
            with os.fdopen(fd, 'wb') as stream, urllib.request.urlopen(base + name, timeout=30) as response:
                if not response.url.startswith('https://'): raise RuntimeError('An insecure download redirect was refused.')
                while True:
                    data = response.read(1024 * 1024)
                    if not data: break
                    guard(owner()); total += len(data)
                    if total > 512 * 1024**2: raise RuntimeError('The K3s binary download exceeded its size limit.')
                    digest.update(data); stream.write(data)
                stream.flush(); os.fsync(stream.fileno())
            if digest.hexdigest() != expected: raise RuntimeError('K3s binary checksum verification failed. Retry the download.')
            value = owner(); value['binaryHash'] = expected; atomic(OWNER, json.dumps(value))
            guard(owner()); os.chmod(path, 0o755); os.replace(path, BIN)
        finally:
            if os.path.exists(path): os.unlink(path)
    value = owner(); value['binaryHash'] = expected; atomic(OWNER, json.dumps(value))
    script = fetch('https://raw.githubusercontent.com/k3s-io/k3s/' + urllib.parse.quote(version, safe='') + '/install.sh', 256 * 1024)
    atomic(ROOT / 'install.sh', script, 0o700)

def configure():
    value = claim()
    host = C['host']
    config = {'node-name': host['nodeName'], 'node-ip': host['privateIp'], 'flannel-iface': host['interfaceName'],
        'node-label': ['openship.io/runtime=' + C['id']], 'kubelet-arg': ['address=' + host['privateIp']], 'protect-kernel-defaults': False}
    if host['role'] == 'server':
        config.update({'bind-address': host['privateIp'], 'advertise-address': host['privateIp'], 'tls-san': [host['privateIp']],
            'cluster-cidr': C['podCidr'], 'service-cidr': C['serviceCidr'], 'flannel-backend': 'vxlan',
            'disable': ['traefik', 'servicelb', 'local-storage'], 'write-kubeconfig-mode': '0600', 'secrets-encryption': True,
            # The agent tunnel dials the kubelet on loopback, which the private-address kubelet refuses
            # (exec/logs on workers fail with "error dialing backend: EOF"). Peers reach 10250 directly.
            'egress-selector-mode': 'disabled'})
    if C['bootstrap']:
        config['cluster-init'] = True
    else:
        token = ROOT / ('join-' + str(C['generation']) + '.token')
        if not token.is_file() or token.is_symlink() or not re.fullmatch(r'K10[a-f0-9]+::server:[^\s]+', token.read_text().strip()): raise RuntimeError('A secure cluster join token is required.')
        atomic(ROOT / 'join.token', token.read_bytes())
        token.unlink()
        config.update({'server': 'https://' + C['bootstrapIp'] + ':6443', 'token-file': str(ROOT / 'join.token')})
    if CONFIG.exists():
        try: same_config = json.loads(CONFIG.read_text()) == config
        except (ValueError, OSError): same_config = False
        if not same_config: raise RuntimeError('The existing runtime configuration has changed outside this setup. Review it before retrying.')
    content = json.dumps(config)
    value['configHash'] = hashlib.sha256(content.encode()).hexdigest()
    atomic(OWNER, json.dumps(value))
    atomic(CONFIG, content)
    guard(value)
    binary()
    env = {key: val for key, val in os.environ.items() if not key.startswith(('K3S_', 'INSTALL_K3S_'))}
    env.update({'INSTALL_K3S_SKIP_DOWNLOAD': 'true', 'INSTALL_K3S_SKIP_START': 'true', 'INSTALL_K3S_SKIP_ENABLE': 'true',
        'INSTALL_K3S_SYMLINK': 'skip', 'INSTALL_K3S_EXEC': host['role'] + ' --config /etc/rancher/k3s/config.yaml'})
    result = subprocess.run(['sh', str(ROOT / 'install.sh')], env=env, capture_output=True, text=True, timeout=120)
    if result.returncode: raise RuntimeError('K3s service installation failed: ' + (result.stderr or result.stdout)[-2400:])
    guard(value)
    unit = 'k3s' if host['role'] == 'server' else 'k3s-agent'
    firewall = ROOT / 'firewall.sh'
    if not firewall.is_file(): raise RuntimeError('The private firewall configuration is missing.')
    atomic('/etc/systemd/system/' + unit + '.service.d/openship.conf', '[Service]\nExecStartPre=/bin/sh ' + str(firewall) + '\n')
    run(['systemctl', 'daemon-reload']); run(['systemctl', 'enable', unit])
    run(['systemctl', 'start', '--no-block', unit])
    value = owner()
    value['installed'] = True
    atomic(OWNER, json.dumps(value))
    return {'installed': True}

def kubectl(args, timeout=30):
    return run([str(BIN), 'kubectl', '--kubeconfig=/etc/rancher/k3s/k3s.yaml', '--server=https://' + C['host']['privateIp'] + ':6443', '--request-timeout=20s'] + args, timeout)

def service_detail(unit):
    # Fatal lines explain a crash loop; etcd/raft chatter in the last few lines does not.
    status = run(['systemctl', 'show', unit, '--property=ActiveState,NRestarts', '--value']).split()
    lines = run(['journalctl', '-u', unit, '-n', '400', '--no-pager', '-o', 'cat']).splitlines()
    fatal = [line for line in lines if re.match(r'(Error: |F\d{4} |time=\S+ level=(fatal|error) )', line)]
    detail = ' | '.join(fatal[-3:]) if fatal else ' '.join(lines[-12:])
    return 'Service is ' + (status[0] if status else 'unknown') + ' after ' + (status[1] if len(status) > 1 else '?') + ' restarts. ' + detail

def readiness():
    value = owner()
    if not value: raise RuntimeError('The owned runtime installation is missing.')
    unit = 'k3s' if C['host']['role'] == 'server' else 'k3s-agent'
    status = run(['systemctl', 'show', unit, '--property=ActiveState', '--value']).strip()
    if status != 'active': return {'ready': False, 'message': service_detail(unit)[-2000:]}
    if C['host']['role'] == 'server':
        try:
            kubectl(['get', '--raw=/readyz'])
            uid = json.loads(kubectl(['get', 'namespace', 'kube-system', '-o', 'json']))['metadata']['uid']
            return {'ready': True, 'clusterUid': uid}
        except Exception as error: return {'ready': False, 'message': (str(error) + ' ' + service_detail(unit))[-2000:]}
    return {'ready': True}

def assert_empty():
    value = owner()
    if not value: raise RuntimeError('The owned runtime installation is missing. Automatic cleanup was refused.')
    # Interrupted verification may have left its disposable pods. They contain no user data.
    checks = json.loads(kubectl(['get', 'namespaces', '-l', 'openship.io/runtime=' + C['id'] + ',openship.io/purpose=runtime-check', '-o', 'json']))['items']
    names = []
    for item in checks:
        name = item['metadata']['name']
        if not re.fullmatch('openship-check-' + re.escape(C['id'][:8]) + r'-\d+', name): raise RuntimeError('An unexpected namespace has the runtime verification label: ' + name)
        names.append(name)
    if names: kubectl(['delete', 'namespace'] + names + ['--wait=true', '--timeout=90s'], 105)
    # Cleanup is refused when workload ownership cannot be established.
    resources = json.loads(kubectl(['get', 'deployments,replicasets,daemonsets,statefulsets,jobs,cronjobs,pods,persistentvolumeclaims', '-A', '-o', 'json']))['items']
    # Empty, owned database operators and storage provisioning are part of this
    # runtime. Their presence must not trap users after deleting all databases.
    # Only their Deployment -> ReplicaSet -> Pod descendants are disposable;
    # volumes, database resources and foreign controllers still block removal.
    addon_deployments = {
        ('cnpg-system', 'cnpg-controller-manager'): 'postgres',
        ('ot-operators', 'redis-operator'): 'redis',
        ('local-path-storage', 'local-path-provisioner'): 'local',
    }
    def owned_addon(item, addon):
        meta = item['metadata']; labels = meta.get('labels', {})
        return labels.get('openship.io/runtime') == C['id'] and labels.get('openship.io/addon') == addon and re.fullmatch(r'[0-9a-f]{64}', meta.get('annotations', {}).get('openship.io/addon-spec', ''))
    accepted = set()
    for item in resources:
        meta = item['metadata']
        addon = addon_deployments.get((meta.get('namespace'), meta.get('name')))
        if item['kind'] == 'Deployment' and addon and owned_addon(item, addon) and meta.get('uid'): accepted.add(meta['uid'])
    for kind in ['ReplicaSet', 'Pod']:
        for item in resources:
            meta = item['metadata']
            if item['kind'] == kind and meta.get('uid') and any(ref.get('uid') in accepted for ref in meta.get('ownerReferences', [])): accepted.add(meta['uid'])
    for item in resources:
        meta = item['metadata']; labels = meta.get('labels', {})
        if meta.get('namespace') == 'kube-system' and labels.get('k8s-app') in ['kube-dns', 'metrics-server']: continue
        if meta.get('uid') in accepted: continue
        raise NotEmptyError('Remove cluster workloads before uninstalling: ' + item['kind'] + ' ' + meta.get('namespace', '') + '/' + meta['name'])
    if json.loads(kubectl(['get', 'persistentvolumes', '-o', 'json']))['items']: raise NotEmptyError('Persistent volumes remain. Back up and remove them before uninstalling the runtime.')
    for item in json.loads(kubectl(['get', 'customresourcedefinitions', '-o', 'json']))['items']:
        if item['metadata']['name'] not in ['addons.k3s.cattle.io', 'etcdsnapshotfiles.k3s.cattle.io', 'helmcharts.helm.cattle.io', 'helmchartconfigs.helm.cattle.io']:
            addon = {'postgresql.cnpg.io': 'postgres', 'redis.redis.opstreelabs.in': 'redis'}.get(item.get('spec', {}).get('group'))
            if not addon or not owned_addon(item, addon): raise NotEmptyError('Remove installed operators and their data before uninstalling: ' + item['metadata']['name'])
            args = ['get', item['metadata']['name'], '-o', 'json']
            if item.get('spec', {}).get('scope') == 'Namespaced': args.append('-A')
            if json.loads(kubectl(args))['items']: raise NotEmptyError('Database resources remain. Remove them before uninstalling: ' + item['metadata']['name'])
    uid = json.loads(kubectl(['get', 'namespace', 'kube-system', '-o', 'json']))['metadata']['uid']
    return {'empty': True, 'clusterUid': uid}

def remove():
    value = owner()
    if not value:
        foreign()
        return {'removed': True}
    guard(value)
    if not (C.get('cleanup') or {}).get('verifiedAt'): raise RuntimeError('Verify that this cluster is empty before removing its runtime.')
    for path, key in [(CONFIG, 'configHash'), (BIN, 'binaryHash')]:
        if path.exists() and (path.is_symlink() or not value.get(key) or digest_file(path) != value[key]):
            raise RuntimeError('The owned runtime file changed outside this setup: ' + str(path) + '. Automatic cleanup was refused.')
    for path in ['/etc/kubernetes', '/etc/cni/net.d', '/etc/rancher/rke2', '/var/lib/rancher/rke2', '/var/lib/k0s', '/var/snap/microk8s']:
        if os.path.lexists(path): raise RuntimeError('Another Kubernetes or CNI installation now uses ' + path + '. Automatic cleanup was refused.')
    value['generation'] = C['generation']; atomic(OWNER, json.dumps(value))
    unit = 'k3s' if value['role'] == 'server' else 'k3s-agent'
    others = [p.name for p in pathlib.Path('/etc/systemd/system').glob('k3s*.service') if p.name != unit + '.service']
    if others: raise RuntimeError('Other Kubernetes services were found. Automatic cleanup was refused: ' + ', '.join(others))
    # Use the release's generated uninstall only after the controller verified no workloads.
    script = pathlib.Path('/usr/local/bin/' + unit + '-uninstall.sh')
    if script.exists():
        killall = pathlib.Path('/usr/local/bin/k3s-killall.sh')
        if shutil.which('tailscale') and killall.exists() and 'tailscale set' in killall.read_text():
            raise RuntimeError('This K3s release cleanup changes Tailscale routes. Automatic removal was refused to preserve the existing network.')
        run(['sh', str(script)], 120)
    elif BIN.exists() or CONFIG.exists() or DATA.exists():
        # Interrupted before the installer wrote units: no running service may be removed here.
        if pathlib.Path('/etc/systemd/system/' + unit + '.service').exists(): raise RuntimeError('The runtime cleanup script is missing. Repair setup before removing it.')
        if DATA.exists(): raise RuntimeError('Runtime data remains but the cleanup script is missing. Repair the installation before removing it.')
        if BIN.exists(): BIN.unlink()
        if CONFIG.exists(): shutil.rmtree(CONFIG.parent)
    for base, chain in [('INPUT', 'OSHIP-K3S-IN'), ('OUTPUT', 'OSHIP-K3S-OUT')]:
        check = subprocess.run(['iptables', '-w', '5', '-C', base, '-j', chain], capture_output=True)
        if check.returncode == 0: run(['iptables', '-w', '5', '-D', base, '-j', chain])
        if subprocess.run(['iptables', '-w', '5', '-S', chain], capture_output=True).returncode == 0:
            run(['iptables', '-w', '5', '-F', chain]); run(['iptables', '-w', '5', '-X', chain])
    dropin = pathlib.Path('/etc/systemd/system/' + unit + '.service.d/openship.conf')
    if dropin.exists(): dropin.unlink()
    run(['systemctl', 'daemon-reload'])
    if BIN.exists() or CONFIG.exists() or DATA.exists(): raise RuntimeError('Runtime cleanup left installed files or data. Inspect the server before retrying.')
    shutil.rmtree(ROOT)
    return {'removed': True}

try:
    if os.geteuid() != 0: raise RuntimeError('Root access is required.')
    if not re.fullmatch(r'[a-f0-9-]{36}', C['id']): raise RuntimeError('Invalid runtime ownership identifier.')
    if ACTION == 'inspect': result = inspect()
    elif ACTION == 'ready': result = readiness()
    elif ACTION == 'empty': result = assert_empty()
    elif ACTION == 'state':
        owner()
        result = {'hasState': (DATA / 'server/db/etcd/member').exists() or (DATA / 'server/db/state.db').exists()}
    elif ACTION == 'nodes': result = json.loads(kubectl(['get', 'nodes', '-o', 'json']))
    elif ACTION == 'claim':
        ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
        with open('/run/lock/openship-k3s.lock', 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX); result = claim()
        result = {'claimed': True}
    else:
        ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
        with open('/run/lock/openship-k3s.lock', 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            result = configure() if ACTION == 'install' else remove() if ACTION == 'remove' else None
            if result is None: raise RuntimeError('Unknown runtime action.')
    print(json.dumps(result))
except Exception as error:
    message = re.sub(r'K10[a-zA-Z0-9:]+', '[redacted]', str(error))
    print(json.dumps({'error': message[-3000:], 'code': 'CLUSTER_RUNTIME_NOT_EMPTY' if isinstance(error, NotEmptyError) else 'CLUSTER_RUNTIME_HOST'}))
`;
