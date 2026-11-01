import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  BUILD_METADATA_IPV4,
  BUILD_METADATA_IPV6,
  BUILD_METADATA_POLICY_VERSION,
  buildKitGuardEntrypoint,
} from "./build-metadata-policy";

it("renders a valid fail-closed shell entrypoint before the BuildKit daemon", () => {
  const script = buildKitGuardEntrypoint();
  expect(() => execFileSync("sh", ["-n"], { input: script })).not.toThrow();
  expect(script).toContain("set -eu");
  expect(script.trimEnd().split("\n").at(-1)).toBe('exec /usr/bin/buildkitd "$@"');
  expect(script).toContain(`OPENSHIP_BUILD_METADATA_GUARD_READY:${BUILD_METADATA_POLICY_VERSION}`);
  // Dedicated nested namespace hooks, never a host network/namespace command.
  expect(script).toContain("-t raw -I PREROUTING 1");
  expect(script).toContain("-t raw -I OUTPUT 1");
  expect(script).not.toMatch(/nsenter|DOCKER-USER|sudo|network=host/);
});

it("denies provider metadata/credential agents without denying their DNS networks", () => {
  expect(BUILD_METADATA_IPV4).toContain("169.254.169.254/32");
  expect(BUILD_METADATA_IPV6).toContain("fd00:ec2::254/128");
  expect(BUILD_METADATA_IPV6).toContain("fd20:ce::254/128");
  expect(BUILD_METADATA_IPV4).not.toContain("169.254.0.0/16");
  expect(BUILD_METADATA_IPV4).not.toContain("169.254.169.253/32");
  expect(BUILD_METADATA_IPV6).not.toContain("fd00:ec2::253/128");
  const script = buildKitGuardEntrypoint();
  const dnsExceptions = script.split("\n").filter((line) => line.includes("-j RETURN"));
  expect(dnsExceptions).toHaveLength(4);
  for (const line of dnsExceptions)
    expect(line).toMatch(
      /-d (169\.254\.169\.254\/32|fd20:ce::254\/128) -p (udp|tcp) --dport 53 -j RETURN$/,
    );
  expect(script.indexOf("--dport 53 -j RETURN")).toBeLessThan(
    script.indexOf("169.254.169.254/32 -j DROP"),
  );
});

it("publishes the same policy identity and guarded entrypoint for both release architectures", () => {
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const file = readFileSync(`${root}/packages/adapters/Dockerfile.buildkit`, "utf8");
  expect(file).toContain(`org.openship.build-metadata-policy="${BUILD_METADATA_POLICY_VERSION}"`);
  expect(file).toContain('ENTRYPOINT ["/usr/local/bin/openship-buildkitd"]');
  expect(file).toMatch(/moby\/buildkit:v[0-9.]+@sha256:[a-f0-9]{64}/);
});
