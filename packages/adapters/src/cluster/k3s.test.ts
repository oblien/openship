import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { clusterRuntimeFixture } from "../../../contracts/test/cluster-runtime-fixtures";
import { k3sFirewallScript, k3sTools } from "./k3s";
import { K3S_HOST } from "./k3s-host";
import type { CommandExecutor } from "../types";

vi.mock("../system/privilege", () => ({
  privilegedExecutor: async (executor: CommandExecutor) => ({
    supported: true,
    value: {
      executor,
      profile: { os: "linux", arch: "amd64", serviceManager: "systemd", firewall: "iptables" },
    },
  }),
}));

function python(body: string) {
  // Execute the actual host functions with OS effects replaced; never provision the test host.
  const script = `import ast, json, pathlib, tempfile, time\nfrom unittest.mock import patch\nsource = ${JSON.stringify(K3S_HOST)}\ntree = ast.parse(source)\ntree.body = [node for node in tree.body if not isinstance(node, ast.Try)]\nns = {}\nwith patch('sys.argv', ['runner', 'test', '{}']):\n    exec(compile(tree, '<k3s-host>', 'exec'), ns)\n${body}`;
  const result = spawnSync("python3", ["-c", script], { encoding: "utf8", timeout: 15_000 });
  expect(result.stderr || result.stdout).not.toContain("AssertionError");
  expect(result.status, result.stderr).toBe(0);
}
describe("K3s host setup", () => {
  it.each([
    { state: "null", ipam: { Config: null } },
    { state: "missing", ipam: {} },
    { state: "empty", ipam: { Config: [] } },
  ])("inspects Docker hosts with $state subnet lists and preserves occupied ranges", ({ ipam }) => {
    const networks = [
      { Name: "host", Driver: "host", IPAM: ipam },
      { Name: "none", Driver: "null", IPAM: ipam },
      {
        Name: "bridge",
        Driver: "bridge",
        IPAM: { Config: [{ Subnet: "172.17.0.0/16" }] },
      },
      {
        Name: "application",
        Driver: "bridge",
        IPAM: {
          Config: [{ Subnet: "10.42.0.0/16" }, { Subnet: "fd00::/64" }, { Subnet: null }, {}],
        },
      },
    ];
    python(`from types import SimpleNamespace
ns['C'] = {'host': {'role': 'server', 'privateIp': '10.20.0.1'}}
ns['owner'] = lambda: None
ns['foreign'] = lambda: None
files = {
    '/proc/swaps': 'Filename Type Size Used Priority\\n',
    '/proc/meminfo': 'MemTotal: 8388608 kB\\n',
    '/sys/fs/cgroup/cgroup.controllers': 'cpuset cpu io memory pids',
    '/etc/resolv.conf': 'nameserver 10.43.0.53\\n',
}
networks = json.loads(${JSON.stringify(JSON.stringify(networks))})
def command(args, **kwargs):
    if args == ['ip', '-j', 'addr', 'show']:
        output = json.dumps([{'ifname': 'eth1', 'flags': ['UP'], 'mtu': 1500, 'addr_info': [{'family': 'inet', 'local': '10.20.0.1', 'prefixlen': 24}]}])
    elif args == ['ip', '-j', '-4', 'route', 'show', 'table', 'all']:
        output = json.dumps([{'dst': 'default'}, {'dst': '0.0.0.0/0'}, {'dst': '10.50.0.0/16'}])
    elif args == ['systemctl', 'is-active', '--quiet', 'docker']:
        output = ''
    elif args == ['docker', 'network', 'ls', '-q']:
        output = 'host-id\\nnone-id\\nbridge-id\\napplication-id\\n'
    elif args == ['docker', 'network', 'inspect', 'host-id', 'none-id', 'bridge-id', 'application-id']:
        output = json.dumps(networks)
    else:
        raise AssertionError('Unexpected command: ' + repr(args))
    return SimpleNamespace(returncode=0, stdout=output, stderr='')
with patch('pathlib.Path.is_dir', lambda path: str(path) == '/run/systemd/system'), \\
     patch('pathlib.Path.exists', lambda path: str(path) in files), \\
     patch('pathlib.Path.is_file', lambda path: str(path) in files), \\
     patch('pathlib.Path.read_text', lambda path: files[str(path)]), \\
     patch('os.cpu_count', return_value=4), \\
     patch('shutil.disk_usage', return_value=SimpleNamespace(free=20 * 1024**3)), \\
     patch('shutil.which', return_value='/usr/bin/docker'), \\
     patch('socket.socket'), \\
     patch('subprocess.run', side_effect=command):
    assert ns['inspect']() == {
        'interfaceName': 'eth1',
        'ranges': ['10.20.0.0/24', '10.42.0.0/16', '10.43.0.53/32', '10.50.0.0/16', '172.17.0.0/16'],
        'installed': False,
    }
`);
  });
  it("refuses cgroup v1 hosts before installing a kubelet that would crash-loop", () => {
    python(`from types import SimpleNamespace
ns['C'] = {'host': {'role': 'server', 'privateIp': '10.20.0.1'}}
ns['owner'] = lambda: None
ns['foreign'] = lambda: None
files = {'/proc/swaps': 'Filename Type Size Used Priority\\n', '/proc/meminfo': 'MemTotal: 8388608 kB\\n'}
with patch('pathlib.Path.is_dir', lambda path: str(path) in ['/run/systemd/system', '/sys/fs/cgroup/memory']), \\
     patch('pathlib.Path.exists', lambda path: str(path) in files), \\
     patch('pathlib.Path.read_text', lambda path: files[str(path)]), \\
     patch('os.cpu_count', return_value=4), \\
     patch('shutil.disk_usage', return_value=SimpleNamespace(free=20 * 1024**3)):
    try:
        ns['inspect']()
        raise AssertionError('cgroup v1 host was accepted')
    except RuntimeError as error:
        assert 'cgroup v1' in str(error) and 'systemd.unified_cgroup_hierarchy=1' in str(error)
`);
  });
  it("reserves upstream DNS addresses hidden behind a local resolver stub", () => {
    python(`with tempfile.TemporaryDirectory() as folder:
    stub = pathlib.Path(folder)/'stub.conf'
    upstream = pathlib.Path(folder)/'upstream.conf'
    stub.write_text('nameserver 127.0.0.53\\n')
    upstream.write_text('nameserver 10.42.1.53\\n# nameserver 10.1.1.1\\nnameserver 2001:db8::1\\n')
    assert set(ns['dns_ranges']([str(stub), str(upstream), folder+'/missing'])) == {'127.0.0.53/32', '10.42.1.53/32'}
`);
  });
  it("renders private peer rules and blocks the VXLAN port on other interfaces", () => {
    const runtime = clusterRuntimeFixture();
    const script = k3sFirewallScript({
      id: runtime.id,
      generation: 1,
      plan: runtime.plan,
      host: runtime.plan.hosts[0]!,
    });
    expect(script).toContain("'-i' 'wg0' '-s' '10.20.0.2/32' '-d' '10.20.0.1/32'");
    expect(script).toContain("'--dport' '8472' '-j' 'DROP'");
    expect(script).not.toContain("203.0.113");
    expect(script).not.toContain("-F INPUT");
    expect(script).not.toContain("-F FORWARD");
    expect(script).toContain(
      "'-i' 'cni0' '-s' '10.42.0.0/16' '-d' '10.20.0.1/32' '-p' 'tcp' '-m' 'multiport' '--dports' '6443,10250' '-j' 'ACCEPT'",
    );
    expect(script).toContain("'--ctstate' 'ESTABLISHED'");
    expect(script).toContain("'--dports' '6443,2379,2380,10250' '-j' 'DROP'");
  });
  it("fences stale remote workers and rejects another runtime's ownership", () => {
    python(`ns['C'] = {'id':'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','generation':2,'deadline':time.time()+60,'host':{'nodeName':'node-a'}}
try:
    ns['guard']({'generation':3,'nodeName':'node-a'})
    raise AssertionError('accepted an old worker')
except RuntimeError as error: assert 'newer' in str(error)
ns['C']['deadline'] = time.time()-1
try:
    ns['guard'](None)
    raise AssertionError('accepted an expired command')
except RuntimeError as error: assert 'expired' in str(error)
with tempfile.TemporaryDirectory() as folder:
    ns['ROOT'] = pathlib.Path(folder)
    ns['OWNER'] = pathlib.Path(folder)/'owner.json'
    ns['OWNER'].write_text(json.dumps({'id':'someone-else'}))
    try:
        ns['owner']()
        raise AssertionError('adopted another runtime')
    except RuntimeError as error: assert 'different OpenShip runtime' in str(error)
`);
  });
  it("keeps API and kubelet on private addresses and leaves Edge and storage ownership separate", () => {
    python(`with tempfile.TemporaryDirectory() as folder:
    ns['ROOT'] = pathlib.Path(folder)
    ns['CONFIG'] = pathlib.Path(folder)/'config.yaml'
    ns['OWNER'] = pathlib.Path(folder)/'owner.json'
    ns['C'] = {'id':'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','generation':1,'deadline':time.time()+60,'host':{'nodeName':'node-a','role':'server','privateIp':'10.20.0.1','interfaceName':'wg0'},'version':'v1.36.4+k3s1','podCidr':'10.42.0.0/16','serviceCidr':'10.43.0.0/16','bootstrap':True}
    ns['claim'] = lambda: {'id':ns['C']['id'],'generation':1,'nodeName':'node-a'}
    ns['binary'] = lambda: None
    ns['run'] = lambda args, timeout=30: ''
    (pathlib.Path(folder)/'firewall.sh').write_text('#!/bin/sh')
    writes = {}
    ns['atomic'] = lambda path,content,mode=0o600: writes.update({str(path):content})
    ns['owner'] = lambda: json.loads(writes[str(ns['OWNER'])])
    with patch('subprocess.run') as call:
        call.return_value.returncode = 0
        assert ns['configure']()['installed']
    config = json.loads(writes[str(ns['CONFIG'])])
    assert config['bind-address'] == '10.20.0.1'
    assert config['kubelet-arg'] == ['address=10.20.0.1']
    assert config['disable'] == ['traefik','servicelb','local-storage']
    assert config['secrets-encryption'] is True
    assert 'token' not in config
`);
  });
  it("does not uninstall when user workloads, volumes or database operators remain", () => {
    python(`ns['C'] = {'id':'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}
ns['owner'] = lambda: {'id':ns['C']['id']}
for items, volumes, crds in [
    ([{'kind':'StatefulSet','metadata':{'name':'postgres','namespace':'default'}}], [], []),
    ([], [{'metadata':{'name':'database-data'}}], []),
    ([], [], [{'metadata':{'name':'clusters.postgresql.cnpg.io'}}]),
]:
    def kubectl(args, timeout=30):
        if args[1]=='namespaces': return json.dumps({'items':[]})
        return json.dumps({'items':volumes if args[1]=='persistentvolumes' else crds if args[1]=='customresourcedefinitions' else items})
    ns['kubectl'] = kubectl
    try:
        ns['assert_empty']()
        raise AssertionError('allowed removal of stateful resources')
    except RuntimeError: pass
ns['kubectl'] = lambda args,timeout=30: json.dumps({'metadata':{'uid':'cluster-a'}} if args[1]=='namespace' else {'items':[]})
assert ns['assert_empty']()['empty']
`);
  });
  it("refuses cleanup when ownership disappeared or installed files were replaced", () => {
    python(`ns['owner'] = lambda: None
def foreign(): raise RuntimeError('An existing Kubernetes installation remains')
ns['foreign'] = foreign
try:
    ns['remove']()
    raise AssertionError('accepted missing ownership with installed files')
except RuntimeError as error: assert 'existing Kubernetes' in str(error)
with tempfile.TemporaryDirectory() as folder:
    ns['ROOT'] = pathlib.Path(folder)
    ns['OWNER'] = pathlib.Path(folder)/'owner.json'
    ns['CONFIG'] = pathlib.Path(folder)/'config.yaml'
    ns['BIN'] = pathlib.Path(folder)/'k3s'
    ns['CONFIG'].write_text('replacement configuration')
    ns['C'] = {'generation':2,'deadline':time.time()+60,'host':{'nodeName':'node-a'},'cleanup':{'verifiedAt':'now'}}
    ns['owner'] = lambda: {'nodeName':'node-a','generation':1,'configHash':'original-hash'}
    try:
        ns['remove']()
        raise AssertionError('deleted changed configuration')
    except RuntimeError as error: assert 'changed outside' in str(error)
`);
  });
  it("allows empty owned database add-ons during runtime cleanup but refuses remaining data or foreign descendants", () => {
    python(`ns['C'] = {'id':'runtime'}
ns['owner'] = lambda: {'id':'runtime'}
labels = {'openship.io/runtime':'runtime','openship.io/addon':'postgres'}
annotations = {'openship.io/addon-spec':'a'*64}
deployment = {'kind':'Deployment','metadata':{'namespace':'cnpg-system','name':'cnpg-controller-manager','uid':'operator','labels':labels,'annotations':annotations}}
replica = {'kind':'ReplicaSet','metadata':{'namespace':'cnpg-system','name':'operator-rs','uid':'replica','ownerReferences':[{'uid':'operator'}]}}
pod = {'kind':'Pod','metadata':{'namespace':'cnpg-system','name':'operator-pod','uid':'pod','ownerReferences':[{'uid':'replica'}]}}
crd = {'metadata':{'name':'clusters.postgresql.cnpg.io','labels':labels,'annotations':annotations},'spec':{'group':'postgresql.cnpg.io','scope':'Namespaced'}}
resources = [pod,replica,deployment]
databases = []
def kubectl(args, timeout=30):
    if args[1]=='namespace': return json.dumps({'metadata':{'uid':'cluster'}})
    values = resources if args[1].startswith('deployments,') else [crd] if args[1]=='customresourcedefinitions' else databases if args[1]=='clusters.postgresql.cnpg.io' else []
    return json.dumps({'items':values})
ns['kubectl'] = kubectl
assert ns['assert_empty']()['empty']
databases.append({'metadata':{'name':'customer-database'}})
try:
    ns['assert_empty']()
    raise AssertionError('removed an operator with existing data')
except RuntimeError as error: assert 'Database resources remain' in str(error)
databases.clear()
pod['metadata']['ownerReferences'] = [{'uid':'different-controller'}]
try:
    ns['assert_empty']()
    raise AssertionError('removed a foreign pod')
except RuntimeError as error: assert 'Remove cluster workloads' in str(error)
`);
  });
  it("validates the release service instead of accepting an arbitrary download target", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ id: "stable", latest: "https://untrusted.example/script" }],
        }),
      });
    vi.stubGlobal("fetch", fetcher);
    try {
      await expect(k3sTools.resolveVersion()).rejects.toThrow("valid stable release");
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("runs a pod on each node, tests their Services and preserves verification errors if cleanup also fails", async () => {
    const runtime = clusterRuntimeFixture();
    let applied = false;
    const executor = {
      writeFile: vi.fn().mockResolvedValue(undefined),
      exec: vi.fn(async (command: string) => {
        if (command.includes("get namespaces -l")) return JSON.stringify({ items: [] });
        if (command.includes("get namespace "))
          return applied
            ? JSON.stringify({ metadata: { labels: { "openship.io/runtime": runtime.id } } })
            : "";
        if (command.includes("apply -f")) {
          applied = true;
          return "created";
        }
        if (command.includes("exec -n") && command.includes("'opsh-c'"))
          throw new Error("DNS lookup failed on node c");
        if (command.includes("delete namespace")) throw new Error("SSH lost during test cleanup");
        return "";
      }),
    };
    await expect(
      k3sTools.verifyNetworking(executor as unknown as CommandExecutor, {
        id: runtime.id,
        generation: 2,
        plan: runtime.plan,
        host: runtime.plan.hosts[0]!,
      }),
    ).rejects.toThrow(/DNS lookup failed on node c[\s\S]*SSH lost during test cleanup/);
    const manifest = JSON.parse(executor.writeFile.mock.calls[0]![1]);
    expect(
      manifest.items
        .filter((item: { kind: string }) => item.kind === "Pod")
        .map((item: { spec: { nodeName: string } }) => item.spec.nodeName),
    ).toEqual(["opsh-a", "opsh-b", "opsh-c"]);
    expect(manifest.items[0].metadata.name).toBe("openship-check-bbbbbbbb-2");
    for (const [command] of executor.exec.mock.calls.filter(([command]) =>
      command.includes("exec -n"),
    )) {
      expect(command).toContain("nslookup kubernetes.default");
      for (const peer of runtime.plan.hosts)
        expect(command).toContain(`${peer.nodeName}.openship-check-bbbbbbbb-2.svc.cluster.local`);
    }
  });
  it("does not delete a newer attempt's verification namespace", async () => {
    const runtime = clusterRuntimeFixture();
    const executor = {
      exec: vi.fn(async (command: string) =>
        command.includes("get namespaces -l")
          ? JSON.stringify({ items: [{ metadata: { name: "openship-check-bbbbbbbb-3" } }] })
          : "",
      ),
      writeFile: vi.fn(),
    };
    await expect(
      k3sTools.verifyNetworking(executor as unknown as CommandExecutor, {
        id: runtime.id,
        generation: 2,
        plan: runtime.plan,
        host: runtime.plan.hosts[0]!,
      }),
    ).rejects.toThrow("Another verification attempt");
    expect(executor.writeFile).not.toHaveBeenCalled();
    expect(
      executor.exec.mock.calls.every(([command]) => !command.includes("delete namespace")),
    ).toBe(true);
  });
});
