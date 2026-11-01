import { AppError, type ClusterStorageConfig } from "@repo/core";
import type { CommandExecutor, LogEntry } from "../types";
import { privilegedExecutor } from "../system/privilege";
import { envOps, opScript } from "../system/environment-ops";
import { checkTool, installTool } from "../toolchain";
import { sq } from "../system/local-shell";

/** Prepares directories without formatting disks or adopting someone else's data. */
export const STORAGE_DIRECTORY_SCRIPT = `
import json, os, pathlib, shutil, subprocess, sys, time
c=json.loads(sys.argv[1])
if time.time()>c['deadline']: raise RuntimeError('Storage preparation expired. Retry setup.')
p=pathlib.Path(c['path'])
for part in [p,*p.parents]:
    if part.is_symlink(): raise RuntimeError('Storage directories must not contain symlinks: '+str(part))
marker=p/'.openship-storage-owner.json'
if marker.exists():
    owner=json.loads(marker.read_text())
    if owner.get('runtimeId') != c['runtimeId']: raise RuntimeError('This directory belongs to another cluster.')
elif p.exists() and any(p.iterdir()):
    raise RuntimeError('Choose an empty dedicated storage directory. Existing files were left unchanged.')
probe=p
while not probe.exists(): probe=probe.parent
filesystem=subprocess.check_output(['findmnt','-n','-o','FSTYPE','--target',str(probe)],text=True).strip()
if filesystem not in ['ext4','xfs']: raise RuntimeError('Choose a local ext4 or XFS disk for shared storage. Found '+filesystem+'.')
usage=shutil.disk_usage(probe)
if usage.free < (c['reservedGiB']+5)*1024**3: raise RuntimeError('The selected disk needs the reserved space plus at least 5 GiB free.')
p.mkdir(parents=True,exist_ok=True)
if not marker.exists():
    fd=os.open(str(marker),os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as f: json.dump({'runtimeId':c['runtimeId']},f)
print(json.dumps({'path':str(p),'freeGiB':usage.free/1024**3}))
`;

export async function prepareStorageHost(
  executor: CommandExecutor,
  runtimeId: string,
  disk: ClusterStorageConfig["disks"][number] | undefined,
  onLog: (entry: LogEntry) => void,
  signal: AbortSignal,
) {
  const result = await privilegedExecutor(executor, "Preparing persistent storage");
  if (!result.supported) throw new AppError(result.reason, 409, "CLUSTER_STORAGE_HOST");
  const { profile, executor: root } = result.value;
  if (profile.os !== "linux" || profile.serviceManager !== "systemd")
    throw new AppError("Managed storage requires Linux and systemd.", 422, "CLUSTER_STORAGE_HOST");
  const ops = envOps(profile);
  const serviceSteps = [ops.serviceEnableStart("iscsid"), ops.serviceIsActive("iscsid")].flatMap(
    (operation) => {
      if (!operation.supported)
        throw new AppError(operation.reason, 422, "CLUSTER_STORAGE_HOST");
      return operation.value;
    },
  );
  for (const tool of ["iscsi-tools", "nfs-client"]) {
    signal.throwIfAborted();
    let state = await checkTool(root, tool);
    if (!state.healthy) {
      const installed = await installTool(executor, tool, onLog, undefined, { signal });
      if (!installed.success) throw new Error(installed.error || `${tool} could not be installed.`);
      state = await checkTool(root, tool);
      if (!state.healthy) throw new Error(state.message);
    }
    onLog({ message: state.message, level: "info", timestamp: new Date().toISOString() });
  }
  signal.throwIfAborted();
  await root.exec(
    opScript(["modprobe iscsi_tcp", "modprobe nfs", ...serviceSteps]),
    { timeout: 60_000 },
  );
  // Kubelet already owns mount propagation. Refuse unsupported setups instead
  // of changing global mount flags or disrupting existing mounts.
  const propagation = (await root.exec("findmnt -n -o PROPAGATION /", { timeout: 15_000 })).trim();
  if (!propagation.includes("shared"))
    throw new Error(
      "Shared volumes require shared mount propagation on the Linux host root mount.",
    );
  if (disk) {
    signal.throwIfAborted();
    const value = { ...disk, runtimeId, deadline: Date.now() / 1000 + 60 };
    await root.exec(
      `timeout 60s python3 -c ${sq(STORAGE_DIRECTORY_SCRIPT)} ${sq(JSON.stringify(value))}`,
      { timeout: 75_000 },
    );
  }
}
