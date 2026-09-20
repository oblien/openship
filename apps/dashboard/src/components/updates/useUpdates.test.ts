import { describe, expect, it, vi } from "vitest";

import { fetchRemoteUncached } from "./useUpdates";

const RELEASE_URL = "https://api.github.com/repos/oblien/openship/releases/latest";
const CHANGELOG_URL = "https://raw.githubusercontent.com/oblien/openship/v0.6.9/CHANGELOG.md";
const MANIFEST_URL =
  "https://raw.githubusercontent.com/oblien/openship/v0.6.9/release-advisories.json";

function response(body: BodyInit, init?: ResponseInit): Response {
  return new Response(body, { status: 200, ...init });
}

describe("fetchRemoteUncached", () => {
  it("uses the tagged changelog instead of the GitHub release body", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === RELEASE_URL) {
        return response(JSON.stringify({ tag_name: "v0.6.9", body: "Bump commit title" }));
      }
      if (url === CHANGELOG_URL) {
        return response(`# Changelog

## 0.6.9

The real product notes.

## 0.6.8

Older notes.`);
      }
      if (url === MANIFEST_URL) return response(JSON.stringify({ advisories: [] }));
      return response("", { status: 404 });
    });

    const result = await fetchRemoteUncached(fetcher as typeof fetch);

    expect(result.latest).toEqual({
      version: "0.6.9",
      tag: "v0.6.9",
      notes: "The real product notes.",
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("keeps advisories when changelog body reading fails", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === RELEASE_URL) return response(JSON.stringify({ tag_name: "v0.6.9" }));
      if (url === CHANGELOG_URL) {
        return { ok: true, text: async () => Promise.reject(new Error("read failed")) };
      }
      if (url === MANIFEST_URL) {
        return response(
          JSON.stringify({
            advisories: [
              {
                id: "critical-update",
                severity: "critical",
                announce: true,
                affects: "<0.6.9",
                title: "Update now",
                message: "Important",
              },
            ],
          }),
        );
      }
      return response("", { status: 404 });
    });

    const result = await fetchRemoteUncached(fetcher as typeof fetch);

    expect(result.latest?.notes).toBe("");
    expect(result.manifest?.advisories[0]?.id).toBe("critical-update");
  });

  it("keeps changelog notes when manifest parsing fails", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === RELEASE_URL) return response(JSON.stringify({ tag_name: "v0.6.9" }));
      if (url === CHANGELOG_URL) return response("## 0.6.9\n\nStill visible.");
      if (url === MANIFEST_URL) {
        return { ok: true, json: async () => Promise.reject(new Error("bad json")) };
      }
      return response("", { status: 404 });
    });

    const result = await fetchRemoteUncached(fetcher as typeof fetch);

    expect(result.latest?.notes).toBe("Still visible.");
    expect(result.manifest).toBeNull();
  });
});
