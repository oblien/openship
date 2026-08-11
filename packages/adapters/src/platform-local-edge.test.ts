import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The bare-OpenResty edge is Linux-only: its paths are Linux FHS (`/var/www/acme`,
 * `/usr/local/openresty/...`), provisioning them needs root, and `installOpenResty`
 * only implements apt. Provisioning it against THIS process's own non-Linux OS
 * therefore can't work — and it didn't fail softly: `ensureOpenRestyConfig` threw
 * `EACCES: permission denied, mkdir '/var/www'` during platform CONSTRUCTION,
 * upstream of every best-effort routing step, so a macOS deploy died before the
 * workload was ever built (issue #262).
 *
 * The gate is scoped to a LOCAL executor on purpose: `process.platform` describes
 * the control plane, not the target, so a Mac driving a remote Linux box must still
 * get the real provider.
 */

// SystemManager + BareRuntime are irrelevant to the routing decision; stub them so
// the test constructs a platform without touching docker, ssh, or the host.
vi.mock("./system/setup", () => ({ SystemManager: class {} }));
vi.mock("./runtime/bare", () => ({ BareRuntime: class {} }));

import { createPlatform } from "./platform";
import { NoopInfraProvider } from "./infra/noop";
import { LocalExecutor } from "./system/local-executor";

/** `process.platform` is read-only; redefine + restore around each case. */
function withPlatform(value: string): () => void {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value, configurable: true });
  return () => Object.defineProperty(process, "platform", original);
}

let restore: (() => void) | undefined;

afterEach(() => {
  restore?.();
  restore = undefined;
  vi.unstubAllEnvs();
});

describe("bare edge gate (local, non-Linux host)", () => {
  it("uses the no-op provider on darwin instead of provisioning /var/www", async () => {
    restore = withPlatform("darwin");
    const platform = await createPlatform({
      target: "selfhosted",
      runtime: "bare",
      executor: new LocalExecutor(),
    });
    expect(platform.routing).toBeInstanceOf(NoopInfraProvider);
    expect(platform.ssl).toBeInstanceOf(NoopInfraProvider);
  });

  it("uses the no-op provider on win32 too", async () => {
    restore = withPlatform("win32");
    const platform = await createPlatform({
      target: "selfhosted",
      runtime: "bare",
      executor: new LocalExecutor(),
    });
    expect(platform.routing).toBeInstanceOf(NoopInfraProvider);
  });

  it("does NOT swap the provider for a REMOTE target, even from a darwin host", async () => {
    // The executor is what decides. A non-local executor means the edge lives on
    // another box, whose OS this check knows nothing about — so the real provider
    // must be built. Asserting the negative is the point: a gate written against
    // `process.platform` alone would silently disable routing for every server
    // deploy driven from a Mac.
    restore = withPlatform("darwin");
    const remote = {
      exec: vi.fn(async () => ""),
      mkdir: vi.fn(async () => {}),
      writeFile: vi.fn(async () => {}),
      readFile: vi.fn(async () => ""),
      exists: vi.fn(async () => true),
      rm: vi.fn(async () => {}),
      streamExec: vi.fn(async () => ({ code: 0, output: "" })),
      transferIn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const platform = await createPlatform({
      target: "selfhosted",
      runtime: "bare",
      executor: remote as never,
    });
    expect(platform.routing).not.toBeInstanceOf(NoopInfraProvider);
    // It went down the real path: detectOpenRestyPaths shells out to `openresty -V`.
    expect(remote.exec).toHaveBeenCalled();
  });
});
