import { describe, expect, it } from "bun:test";
import { matchAdvisories } from "../packages/core/src/updates/advisories";
import { buildReleaseAdvisory } from "./release-advisory";

const recovery = {
  id: "update-9.8.7",
  severity: "recommended",
  announce: true,
  affects: ">=9.8.5 <9.8.7",
  modes: ["desktop"],
  title: "Install the desktop update manually once",
  message: "Download the installer and replace the application. Keep application data.",
  action: {
    label: "Download installer",
    kind: "open-url",
    url: "https://github.com/oblien/openship/releases/tag/v9.8.7",
  },
};
const manifest = { advisories: [recovery] };

describe("release announcements", () => {
  it("preserves the prepared download link, recovery copy and version range", () => {
    expect(buildReleaseAdvisory("9.8.7", {}, manifest)).toEqual(recovery);
  });

  it("can make recovery critical without replacing it with the broken update action", () => {
    expect(buildReleaseAdvisory("9.8.7", { critical: true }, manifest)).toEqual({
      ...recovery, severity: "critical",
    });
  });

  it("shows recovery only to affected desktop versions", () => {
    const notice = { advisories: [buildReleaseAdvisory("9.8.7", {}, manifest)] };
    for (const version of ["9.8.5", "9.8.6"]) {
      expect(matchAdvisories(version, notice, "desktop")).toHaveLength(1);
      expect(matchAdvisories(version, notice, "selfhosted")).toHaveLength(0);
      expect(matchAdvisories(version, notice, "cloud")).toHaveLength(0);
    }
    for (const version of ["9.8.4", "9.8.7", "9.8.8"]) {
      expect(matchAdvisories(version, notice, "desktop")).toHaveLength(0);
    }
  });

  it("uses the normal update action for a different release", () => {
    const next = buildReleaseAdvisory("9.8.8", {}, manifest);
    expect(next.id).toBe("update-9.8.8");
    expect(next.affects).toBe("<9.8.8");
    expect(next.modes).toBeUndefined();
    expect(next.action).toEqual({ label: "Update now", kind: "update" });
  });

  it("honors explicit release options without mutating the prepared notice", () => {
    const next = buildReleaseAdvisory("9.8.7", { message: "Operator copy", modes: ["selfhosted"] }, manifest);
    expect(next.message).toBe("Operator copy");
    expect(next.modes).toEqual(["selfhosted"]);
    expect(next.action).toEqual(recovery.action);
    expect(recovery.message).toContain("Keep application data");
    expect(recovery.modes).toEqual(["desktop"]);
  });
});
