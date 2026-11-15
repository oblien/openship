import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const jobs = (name: string) => (Bun.YAML.parse(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8")) as any).jobs;

describe("installed VPS CLI publication gate", () => {
  it("tests the actual packaged CLI under supported LTS runtimes on both Linux architectures", () => {
    const gate = jobs("release")["installed-cli-update"];
    expect(gate.needs).toEqual(["images-ready", "build-cli-payload"]);
    expect(gate.strategy.matrix.runner).toEqual(["ubuntu-24.04", "ubuntu-24.04-arm"]);
    expect(gate.strategy.matrix.node).toEqual(["22", "24"]);
    expect(gate.steps.find((step: any) => step.uses?.startsWith("actions/download-artifact"))?.with.name).toBe("openship-cli-release");
    const exercise = gate.steps.find((step: any) => step.run?.includes("verify-vps-cli-update"));
    expect(exercise.env.OPENSHIP_TEST_ISOLATED_VPS).toBe("1");
    expect(exercise.run).toContain("OPENSHIP_E2E_CLI_PAYLOAD");
  });
  it("blocks GitHub and ordinary npm publication when the installed update test fails", () => {
    const release = jobs("release");
    for (const name of ["publish", "publish-npm"]) expect(release[name].needs).toContain("installed-cli-update");
    expect(release["publish-npm"].if).toContain("needs.installed-cli-update.result == 'success'");
    for (const name of ["installed-cli-update", "build-cli-payload"]) {
      expect(release[name].if).toContain("inputs.npm_release_run == ''");
    }
  });
  it("also gates Docker publication with the real candidate CLI reconciliation", () => {
    const update = jobs("docker-images")["update-e2e"];
    const exercise = update.steps.find((step: any) => step.run?.includes("verify-vps-cli-update"));
    expect(exercise).toBeDefined();
    expect(exercise.env.OPENSHIP_TEST_ISOLATED_VPS).toBe("1");
    expect(exercise.run).toContain("OPENSHIP_E2E_OLD_VERSION");
  });
});
