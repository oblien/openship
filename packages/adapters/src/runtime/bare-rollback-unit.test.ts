import { beforeEach, expect, it, vi } from "vitest";
import { BareRuntime } from "./bare";
import { LocalExecutor } from "../system/executor";
import { SystemdSupervisor } from "./supervisor/systemd";
import { NohupSupervisor } from "./supervisor/nohup";
import type { ProcessSupervisor } from "./supervisor/types";

const h = vi.hoisted(() => ({ supervisor: null as ProcessSupervisor | null }));
vi.mock("./supervisor/detect", () => ({ detectSupervisor: async () => h.supervisor! }));

const WORK_DIR = "/tmp/openship-unit-retention-test";
const target = { id: "dep_old", projectId: "project", containerId: "dep_old", imageRef: null };
const active = { id: "dep_live", projectId: "project", containerId: "dep_live", imageRef: null };
class Host extends LocalExecutor {
  paths = new Set([`${WORK_DIR}/releases/dep_old`, "/etc/systemd/system/openship-dep_old.service"]);
  commands: string[] = [];
  override async exists(path: string) { return this.paths.has(path); }
  override async exec(command: string) { this.commands.push(command); return ""; }
}
let host: Host;
let runtime: BareRuntime;
beforeEach(() => {
  host = new Host();
  h.supervisor = new SystemdSupervisor(host, WORK_DIR);
  runtime = new BareRuntime({ executor: host, workDir: WORK_DIR });
});

it("only offers a unit restore when both release files and restart configuration exist", async () => {
  expect(await runtime.canRestoreUnit(target)).toBe(true);
  host.paths.delete(`${WORK_DIR}/releases/dep_old`);
  expect(await runtime.canRestoreUnit(target)).toBe(false);
});

it("does not stop the live process for a target whose unit was removed", async () => {
  host.paths.delete("/etc/systemd/system/openship-dep_old.service");
  expect(await runtime.canRestoreUnit(target)).toBe(false);
  await expect(runtime.makeActive({ from: active, to: target })).rejects.toThrow("Cannot restart");
  expect(host.commands).toEqual([]);
});

it("rejects a nohup unit swap before stopping anything", async () => {
  h.supervisor = new NohupSupervisor(host, WORK_DIR);
  expect(await runtime.canRestoreUnit(target)).toBe(false);
  await expect(runtime.makeActive({ from: active, to: target })).rejects.toThrow("Redeploy it from source");
  expect(host.commands).toEqual([]);
});

it("still swaps a retained systemd release in the correct order", async () => {
  await runtime.makeActive({ from: active, to: target });
  expect(host.commands.filter((command) => /^systemctl (start|stop) /.test(command))).toEqual([
    "systemctl stop 'openship-dep_live.service' 2>/dev/null || true",
    "systemctl start 'openship-dep_old.service'",
  ]);
});
