import { describe, expect, it } from "vitest";
import { missingBuildCommands } from "./build-commands";

describe("missingBuildCommands", () => {
  it.each([undefined, null, "", " \n\t "])(
    "treats %s as missing for generated web apps",
    (blank) => {
      expect(
        missingBuildCommands({
          build: "buildpack",
          workload: "web",
          hasBuild: true,
          installCommand: blank,
          startCommand: blank,
        }),
      ).toEqual(["installCommand", "startCommand"]);
    },
  );
  it.each(["dockerfile", "prebuilt"] as const)("allows %s to own its commands", (build) => {
    expect(missingBuildCommands({ build, workload: "web", hasBuild: true })).toEqual([]);
  });
  it("only requires installation for a static build", () => {
    expect(missingBuildCommands({ build: "static", workload: "static", hasBuild: true })).toEqual([
      "installCommand",
    ]);
    expect(missingBuildCommands({ build: "static", workload: "static", hasBuild: false })).toEqual(
      [],
    );
  });
  it("requires worker startup even without a build step", () => {
    expect(
      missingBuildCommands({ build: "buildpack", workload: "worker", hasBuild: false }),
    ).toEqual(["startCommand"]);
  });
  it("preserves explicit nonempty commands", () => {
    expect(
      missingBuildCommands({
        build: "buildpack",
        workload: "web",
        hasBuild: true,
        installCommand: "custom-install --locked",
        startCommand: "custom-server",
      }),
    ).toEqual([]);
  });
});
