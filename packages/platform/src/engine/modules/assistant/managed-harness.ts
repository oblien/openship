import type { CommandExecutor } from "@repo/adapters";
import type { AssistantProvider, AssistantProviderInfo } from "@repo/contracts";
import type { AssistantNativeClient } from "./native-target";
import { HARNESS } from "./harness-policy";

/** Mindwire owns the approved versions and installation job. Its installation
 * profile is separate from the execution profile: managed CLI selections must
 * never bypass OpenShip's scoped harness wrappers. No sign-in is imported. */
export function managedHarness(input: {
  directory: string;
  executor: CommandExecutor;
  connect(): Promise<AssistantNativeClient>;
}) {
  let pending: Promise<AssistantNativeClient> | undefined;
  async function client() {
    // Both provider probes share this profile. Queue recovery so a concurrent
    // refresh cannot close or replace another refresh's new connection.
    const next = Promise.resolve(pending).then(async (current) => {
      if (current?.healthy()) return current;
      await current?.close();
      return input.connect();
    });
    pending = next;
    try {
      return await next;
    } catch (error) {
      if (pending === next) pending = undefined;
      throw error;
    }
  }
  return {
    async state(provider: AssistantProvider): Promise<AssistantProviderInfo["setup"]> {
      // Opening connection settings never starts a toolchain installation.
      if (!(await input.executor.exists(`${input.directory}/service.json`))) return undefined;
      const status = await (await client()).mindwire
        .withAgent(HARNESS[provider].agent)
        .setupStatus();
      if (status.running) return { state: "installing" };
      if (status.started && !status.ok) return { state: "failed" };
      return undefined;
    },
    async executable(provider: AssistantProvider): Promise<string | undefined> {
      const binary = HARNESS[provider].binary;
      const directory = `${input.directory}/toolchains/${binary}`;
      const selection = `${directory}/selected.json`;
      if (!(await input.executor.exists(selection))) return undefined;
      const raw = await input.executor.readFile(selection);
      if (raw.length > 4096) throw new Error("Invalid managed agent selection");
      const { version } = JSON.parse(raw);
      if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version))
        throw new Error("Invalid managed agent version");
      return `${directory}/versions/${version}/bin/${binary}`;
    },
    async start(provider: AssistantProvider) {
      const mw = (await client()).mindwire.withAgent(HARNESS[provider].agent);
      const status = await mw.setupStatus();
      if (status.running) return;
      // This action is offered only when the execution probe is unavailable.
      // Repair a previous install even if the SDK last saw it succeed.
      if (status.started) await mw.update();
      else await mw.setup();
    },
    async close() {
      const closing = pending;
      pending = undefined;
      if (closing) await (await closing).close();
    },
  };
}
