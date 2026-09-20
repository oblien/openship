import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { MANAGED_NETWORK_HOST } from "./managed-network-host";

const exec = promisify(execFile);
const pythonAvailable = (() => {
  try {
    execFileSync("python3", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();

// Execute the complete host program against real temporary receipts/config files.
// Only OS commands are substituted; no registered servers or host network are used.
const harness = String.raw`
import contextlib, copy, io, json, pathlib, re, subprocess, sys, tempfile, time, types
input = json.loads(sys.argv[1])
state = {'exists': False, 'up': False, 'mtu': 1400, 'addresses': [], 'routes': [], 'peers': [], 'allowedIps': {}, 'publicKey': '', 'listenPort': None, 'enabled': False, 'firewall': False, 'firewallRevision': 'policy-v1'}
commands = []
def command(args, **kwargs):
 commands.append(args)
 output = ''
 if args[:2] == ['wg', 'pubkey']: output = 'public:' + kwargs['input'].strip()
 elif args[:2] == ['wg', 'setconf']:
  if input.get('scenario') == 'stage_failure':
   input['scenario'] = 'failed'
   return types.SimpleNamespace(returncode=2, stdout='', stderr='Unable to access interface: Protocol not supported')
  text = pathlib.Path(args[-1]).read_text()
  state['publicKey'] = 'public:' + re.search(r'PrivateKey = (.*)', text)[1]
  state['peers'] = re.findall(r'PublicKey = (.*)', text)
  state['allowedIps'] = dict(zip(state['peers'], re.findall(r'AllowedIPs = (.*)', text)))
  state['listenPort'] = int(re.search(r'ListenPort = (.*)', text)[1])
 elif args[:2] == ['wg', 'show']:
  if args[-1] == 'public-key': output = state['publicKey'] if state['exists'] else ''
  elif args[-1] == 'peers': output = '\n'.join(state['peers'])
  elif args[-1] == 'listen-port': output = str(state['listenPort'])
  elif args[-1] == 'allowed-ips': output = '\n'.join(key + '\t' + state['allowedIps'].get(key, '(none)') for key in state['peers'])
  elif args[-1] == 'latest-handshakes': output = '\n'.join(key + ' 1700000000' for key in state['peers'])
 elif args[0] == 'ip':
  if args == ['ip', '-d', '-j', 'addr', 'show']:
   output = json.dumps([{'ifname': 'oswg' + 'a' * 10, 'mtu': state['mtu'], 'flags': ['UP'] if state['up'] else [], 'linkinfo': {'info_kind': 'wireguard'}, 'addr_info': [{'family': 'inet', 'local': value.split('/')[0], 'prefixlen': int(value.split('/')[1])} for value in state['addresses']]}] if state['exists'] else [])
  elif args == ['ip', '-j', '-4', 'route', 'show', 'table', 'main']:
   output = json.dumps([{'dst': value[:-3] if value.endswith('/32') else value, 'dev': 'oswg' + 'a' * 10, 'prefsrc': state['addresses'][0].split('/')[0]} for value in state['routes']])
  elif args[-2:] == ['link', 'show']:
   output = json.dumps([{'ifname': 'oswg' + 'a' * 10, 'linkinfo': {'info_kind': 'wireguard'}}] if state['exists'] else [])
  elif args[1:3] == ['link', 'add']: state['exists'] = True
  elif args[1:3] == ['link', 'delete']: state.update(exists=False, addresses=[], routes=[], peers=[])
  elif args[1:3] == ['address', 'add']: state['addresses'].append(args[3])
  elif args[1:3] == ['link', 'set']:
   state['mtu'] = int(args[args.index('mtu') + 1]); state['up'] = args[-1] == 'up'
  elif args[1:4] == ['-4', 'route', 'add']:
   if input.get('scenario') == 'route_failure':
    input['scenario'] = 'failed'
    return types.SimpleNamespace(returncode=2, stdout='', stderr='RTNETLINK answers: File exists')
   state['routes'].append(args[4])
  elif args[1:3] != ['link', 'set']: raise AssertionError('Unexpected ip command: ' + str(args))
 elif args[0] == 'sh':
  if args[-1] == 'enable-owned-service': state['enabled'] = True
  elif args[-1] == 'disable-owned-service': state['enabled'] = False
  elif args[-1] == 'apply-owned-firewall': state['firewall'] = True
  elif args[-1] == 'remove-owned-firewall': state['firewall'] = False
  elif args[-1] == 'inspect-owned-firewall': output = 'OSWG_' + 'a' * 16 + '_IN' if state['firewall'] else ''
  elif args[-1] == 'snapshot-owned-firewall': output = state['firewallRevision'] if state['firewall'] else 'missing'
 else: raise AssertionError('Unexpected command: ' + str(args))
 return types.SimpleNamespace(returncode=0, stdout=output, stderr='')
subprocess.run = command
with tempfile.TemporaryDirectory() as directory:
 identity = 'a' * 32
 base = pathlib.Path(directory) / 'networks' / identity; base.mkdir(parents=True)
 common = {'managedId': identity, 'interfaceName': 'oswg' + 'a' * 10, 'stateDir': directory, 'operationId': '00000000-0000-4000-8000-000000000001', 'generation': 1, 'expectedConfigHash': None, 'firewallInspect': 'inspect-owned-firewall'}
 config = {
  'managedId': identity, 'interfaceName': common['interfaceName'], 'mtu': 1400,
  'privateIp': '10.244.0.1', 'listenPort': 51900,
  'peers': [{'serverId': 'peer', 'publicKey': 'peer-key', 'privateIp': '10.244.0.2', 'endpoint': '192.0.2.2', 'listenPort': 51901}],
  'firewall': {'up': ['apply-owned-firewall'], 'down': ['remove-owned-firewall'], 'inspect': 'inspect-owned-firewall'}
 }
 before = dict(config, privateIp='10.243.0.1') if input.get('existing') else None
 if input.get('policy'):
  config['routeCidrs'] = ['10.244.0.0/24']
  config['firewall'] = dict(config['firewall'], snapshot='snapshot-owned-firewall')
 (base / 'before.json').write_text(json.dumps(before))
 if before:
  (base / 'network.json').write_text(json.dumps(before)); (base / 'private.key').write_text('old-fixture-key')
  (base / 'before.key').write_text('old-fixture-key')
  state.update(exists=True, up=True, addresses=['10.243.0.1/32'], routes=['10.244.0.2/32'], peers=['peer-key'], allowedIps={'peer-key': '10.244.0.2/32'}, publicKey='public:old-fixture-key', listenPort=51900, enabled=True)
 (base / 'staged.key').write_text('new-fixture-key')
 receipt = {
  'operationId': common['operationId'], 'generation': 1, 'stage': 'prepared', 'deadline': int(time.time()) + 1200,
  'beforeHash': None, 'afterHash': None,
  'services': {'enable': 'enable-owned-service', 'disable': 'disable-owned-service', 'cancelTimer': 'cancel-owned-timer'}
 }
 (base / 'receipt.json').write_text(json.dumps(receipt))
 def invoke(action, extra=None):
  sys.argv = ['fixture', action, json.dumps(dict(common, **(extra or {})))]
  output = io.StringIO()
  with contextlib.redirect_stdout(output):
   try: exec(input['program'], {})
   except SystemExit as end:
    if end.code not in (None, 0): raise
  return json.loads(output.getvalue())
 if before:
  receipt['beforeHash'] = common['expectedConfigHash'] = invoke('status')['configHash']
  (base / 'receipt.json').write_text(json.dumps(receipt))
 commands.clear()
 def snapshot(result):
  current = json.loads((base / 'network.json').read_text()) if (base / 'network.json').exists() else None
  return {'result': result, 'state': copy.deepcopy(state), 'commands': copy.deepcopy(commands), 'receipt': json.loads((base / 'receipt.json').read_text()) if (base / 'receipt.json').exists() else None, 'transportOnly': bool(current and current.get('transportOnly'))}
 staged = snapshot(invoke('apply', {'config': dict(config, transportOnly=True)}))
 commands.clear()
 scenario = input.get('scenario', 'promote')
 if scenario == 'commit': result = invoke('commit')
 elif scenario.startswith('commit_'):
  promoted = invoke('apply', {'config': config})
  if promoted.get('error'): raise AssertionError('Could not configure fixture: ' + str(promoted))
  if scenario == 'commit_missing_address': state['addresses'] = []
  if scenario == 'commit_missing_route': state['routes'] = []
  if scenario == 'commit_wrong_mtu': state['mtu'] = 1280
  if scenario == 'commit_link_down': state['up'] = False
  if scenario == 'commit_wrong_port': state['listenPort'] += 1
  if scenario == 'commit_wrong_allowed_ips': state['allowedIps']['peer-key'] = '0.0.0.0/0'
  if scenario == 'commit_firewall_drift': state['firewallRevision'] = 'policy-bypassed'
  commands.clear(); result = invoke('commit')
 elif scenario == 'boot': result = invoke('boot')
 elif scenario == 'timer':
  receipt = json.loads((base / 'receipt.json').read_text()); receipt['deadline'] = int(time.time()) - 1
  (base / 'receipt.json').write_text(json.dumps(receipt)); result = invoke('timer')
 elif scenario in ('rollback', 'failed'): result = invoke('rollback')
 elif scenario.startswith('missing_receipt'):
  restored = invoke('rollback')
  if restored.get('error'): raise AssertionError('Could not restore fixture: ' + str(restored))
  (base / 'receipt.json').unlink()
  if scenario == 'missing_receipt_link': state['exists'] = True
  if scenario == 'missing_receipt_firewall': state['firewall'] = True
  if scenario == 'missing_receipt_route': state['routes'] = []
  commands.clear(); result = invoke('rollback')
 else:
  if scenario == 'drift': config['listenPort'] += 1
  result = invoke('apply', {'config': config})
 final = snapshot(result)
 if result.get('error') and scenario == 'route_failure':
  commands.clear(); final['recovery'] = snapshot(invoke('rollback'))
 print(json.dumps({'staged': staged, 'final': final}))
`;

async function run(scenario = "promote", existing = false, policy = false) {
  const { stdout } = await exec(
    "python3",
    [
      "-c",
      harness,
      JSON.stringify({
        program: MANAGED_NETWORK_HOST,
        scenario,
        existing,
        policy,
      }),
    ],
    { timeout: 10_000, maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

describe.skipIf(!pythonAvailable)("WireGuard transport gate and recovery", () => {
  it("routes a restricted subnet through the owned interface and verifies the installed policy before commit", async () => {
    const { staged, final } = await run("commit_complete", false, true);
    expect(staged.result).toMatchObject({ stage: "applied", healthy: true });
    expect(staged.state.routes).toEqual([]);
    expect(final.state.routes).toEqual(["10.244.0.0/24"]);
    expect(final.result).toMatchObject({ stage: "committed", healthy: true });
  });
  it("keeps rollback armed if the installed connection firewall drifts", async () => {
    const { final } = await run("commit_firewall_drift", false, true);
    expect(final.result.error).toContain("no longer matches the verified network");
    expect(final.commands).not.toContainEqual(["sh", "-c", "cancel-owned-timer"]);
    expect(final.receipt.stage).toBe("applied");
  });
  it("restores previous routes and firewall after a connection-policy change is abandoned", async () => {
    const { final } = await run("rollback", true, true);
    expect(final.result).toMatchObject({ stage: "rolled_back", healthy: true });
    expect(final.state.routes).toEqual(["10.244.0.2/32"]);
    expect(final.state.publicKey).toBe("public:old-fixture-key");
  });
  it("stages the reviewed UDP endpoint without private addresses, routes or enabling startup", async () => {
    const { staged } = await run();
    expect(staged.result).toMatchObject({ stage: "applied", healthy: true });
    expect(staged.state).toMatchObject({
      exists: true,
      listenPort: 51900,
      addresses: [],
      routes: [],
      enabled: false,
    });
    expect(staged.transportOnly).toBe(true);
    expect(staged.commands).toContainEqual(["sh", "-c", "apply-owned-firewall"]);
    expect(staged.commands).not.toContainEqual(["sh", "-c", "cancel-owned-timer"]);
    expect(staged.receipt.deadline).toBeGreaterThan(Date.now() / 1000);
  });
  it("promotes the same interface and keys without resetting verified handshakes", async () => {
    const { staged, final } = await run();
    expect(final.result).toMatchObject({ stage: "applied", healthy: true });
    expect(final.state).toMatchObject({
      addresses: ["10.244.0.1/32"],
      routes: ["10.244.0.2/32"],
      enabled: true,
    });
    expect(final.transportOnly).toBe(false);
    expect(final.commands.some((args: string[]) => args[0] === "wg" && args[1] === "setconf")).toBe(
      false,
    );
    expect(final.commands.some((args: string[]) => args[0] === "ip" && args[1] === "link")).toBe(
      false,
    );
    expect(final.receipt.deadline).toBe(staged.receipt.deadline);
    expect(final.receipt.afterHash).not.toBe(staged.receipt.afterHash);
  });
  it("refuses to commit a transport-only configuration and leaves recovery armed", async () => {
    const { final } = await run("commit");
    expect(final.result.error).toContain("UDP transport alone cannot be committed");
    expect(final.transportOnly).toBe(true);
    expect(final.commands).not.toContainEqual(["sh", "-c", "cancel-owned-timer"]);
  });
  it("commits a complete private network and disarms its rollback timer", async () => {
    const { final } = await run("commit_complete");
    expect(final.result).toMatchObject({ stage: "committed", healthy: true });
    expect(final.commands).toContainEqual(["sh", "-c", "cancel-owned-timer"]);
  });
  it.each([
    "commit_missing_address",
    "commit_missing_route",
    "commit_wrong_mtu",
    "commit_link_down",
    "commit_wrong_port",
    "commit_wrong_allowed_ips",
  ])(
    "keeps recovery armed when the live network changes after verification: %s",
    async (scenario) => {
      const { final } = await run(scenario);
      expect(final.result.error).toContain("no longer matches the verified network");
      expect(final.receipt.stage).toBe("applied");
      expect(final.commands).not.toContainEqual(["sh", "-c", "cancel-owned-timer"]);
    },
  );
  it("does not add private routes if the staged configuration changes before promotion", async () => {
    const { final } = await run("drift");
    expect(final.result.error).toContain("verified WireGuard transport changed");
    expect(final.state.addresses).toEqual([]);
    expect(final.state.routes).toEqual([]);
  });
  it("keeps a rebooted transport stage free of private addresses and routes", async () => {
    const { final } = await run("boot");
    expect(final.result).toEqual({ ok: true });
    expect(final.transportOnly).toBe(true);
    expect(final.state).toMatchObject({ exists: true, addresses: [], routes: [] });
  });
  it.each([false, true])(
    "restores the original configuration after transport failure (existing: %s)",
    async (existing) => {
      const { final } = await run("rollback", existing);
      expect(final.result.stage).toBe("rolled_back");
      expect(final.state).toMatchObject(
        existing
          ? {
              exists: true,
              addresses: ["10.243.0.1/32"],
              publicKey: "public:old-fixture-key",
              enabled: true,
            }
          : { exists: false, addresses: [], routes: [], enabled: false },
      );
      expect(final.transportOnly).toBe(false);
      expect(final.commands).toContainEqual(["sh", "-c", "remove-owned-firewall"]);
    },
  );
  it("lets the host timer restore an abandoned transport stage independently", async () => {
    const { final } = await run("timer");
    expect(final.result).toEqual({ ok: true });
    expect(final.receipt.stage).toBe("rolled_back");
    expect(final.state).toMatchObject({ exists: false, addresses: [], routes: [], enabled: false });
  });
  it.each([false, true])(
    "accepts a missing receipt only when the original network is intact (existing: %s)",
    async (existing) => {
      const { final } = await run("missing_receipt_clean", existing);
      expect(final.result).toEqual({ missing: true });
      expect(final.receipt).toBeNull();
    },
  );
  it.each([
    ["missing_receipt_link", false],
    ["missing_receipt_firewall", false],
    ["missing_receipt_route", true],
  ] as const)(
    "refuses to acknowledge missing recovery state while the live network differs: %s",
    async (scenario, existing) => {
      const { final } = await run(scenario, existing);
      expect(final.result.error).toContain(
        "no longer matches this operation or its original configuration",
      );
      expect(final.receipt).toBeNull();
      expect(final.commands).not.toContainEqual(["sh", "-c", "cancel-owned-timer"]);
      expect(final.commands).not.toContainEqual(["sh", "-c", "remove-owned-firewall"]);
    },
  );
  it("retains the receipt needed to restore a partially failed transport configuration", async () => {
    const { staged, final } = await run("stage_failure");
    expect(staged.result.error).toContain("Protocol not supported");
    expect(staged.receipt.changed).toBe(true);
    expect(final.result.stage).toBe("rolled_back");
    expect(final.state.exists).toBe(false);
  });
  it("restores a partial promotion when a private route conflicts", async () => {
    const { final } = await run("route_failure");
    expect(final.result.error).toContain("RTNETLINK answers: File exists");
    expect(final.recovery.result.stage).toBe("rolled_back");
    expect(final.recovery.state).toMatchObject({ exists: false, addresses: [], routes: [] });
  });
});
