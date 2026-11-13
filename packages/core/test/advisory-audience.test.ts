import { describe, expect, it } from "vitest";
import { matchAdvisories, resolveUpdateState } from "../src/updates/advisories";
import type { Advisory } from "../src/updates/types";

const release: Advisory = {
  id: "legacy-release-notice",
  severity: "recommended",
  announce: false,
  affects: "*",
  title: "OpenShip 0.9.0 is released",
  message: "View the release notes and downloads.",
  action: {
    kind: "open-url",
    label: "View release notes",
    url: "https://github.com/oblien/openship/releases/tag/v0.9.0",
  },
  target: { type: "platform" },
};
const matches = (advisory: Advisory, mode: "cloud" | "desktop" | "selfhosted") =>
  matchAdvisories("0.9.12", { advisories: [advisory] }, mode);

describe("managed Cloud advisory audience", () => {
  it("hides the legacy unexpired release notice on Cloud without suppressing operator installs", () => {
    expect(matches(release, "cloud")).toEqual([]);
    expect(matches(release, "desktop")).toEqual([release]);
    expect(matches(release, "selfhosted")).toEqual([release]);
  });

  it.each([
    "https://github.com/oblien/openship/releases",
    "https://github.com/oblien/openship/releases/download/v0.9.0/Openship.dmg",
    "https://openship.io/changelog",
    "https://openship.io/changelog/v0-9-0",
    "https://openship.io/download",
  ])("excludes installation-release links without depending on their title: %s", (url) => {
    const notice = {
      ...release,
      title: "A translated announcement",
      target: undefined,
      action: { ...release.action!, url },
    };
    expect(matches(notice, "cloud")).toEqual([]);
    expect(matches(notice, "desktop")).toEqual([notice]);
  });

  it("does not offer native installation updates to Cloud, even with critical severity", () => {
    const notice: Advisory = {
      ...release,
      severity: "critical",
      modes: ["cloud"],
      action: { kind: "update", label: "Update now" },
    };
    const state = resolveUpdateState({
      currentVersion: "0.9.12",
      latestRelease: null,
      manifest: { advisories: [notice] },
      mode: "cloud",
    });
    expect(state.advisories).toEqual([]);
  });

  it.each(["app", "project", "mail"] as const)(
    "preserves affected %s notices even when they link to a release",
    (type) => {
      const notice = { ...release, target: { type, id: "affected-workload" } };
      expect(matches(notice, "cloud")).toEqual([notice]);
    },
  );

  it.each([
    "https://status.openship.io/maintenance",
    "https://github.com/oblien/openship/security/advisories/GHSA-example",
    "https://github.com/oblien/openship/releases-incident",
    "https://github.com/another/project/releases/tag/v1.0.0",
    "https://github.com.example.test/oblien/openship/releases/tag/v0.9.0",
    "https://openship.io/changelog-incident",
    "https://openship.io.example.test/changelog",
  ])("keeps unrelated maintenance and security notices: %s", (url) => {
    const notice = {
      ...release,
      severity: "critical" as const,
      action: { ...release.action!, url },
    };
    expect(matches(notice, "cloud")).toEqual([notice]);
  });

  it("keeps operational notices without a release action and still respects explicit audiences", () => {
    const notice = { ...release, action: undefined };
    expect(matches(notice, "cloud")).toEqual([notice]);
    expect(matches({ ...notice, modes: ["selfhosted"] }, "cloud")).toEqual([]);
  });
});
