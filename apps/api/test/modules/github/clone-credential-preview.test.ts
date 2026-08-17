import { describe, expect, it } from "vitest";
import {
  browseIdentityFromState,
  type CloneIdentity,
} from "../../../src/modules/github/clone-credential-preview";
import type { GitHubConnectionState } from "../../../src/modules/github/github.types";

const state = (over: Partial<GitHubConnectionState> = {}): GitHubConnectionState => ({
  sources: {
    openshipApp: { connected: false },
    ghCli: { available: false },
  },
  primary: null,
  ...over,
});

describe("browseIdentityFromState", () => {
  it("names the connected device identity", () => {
    const identity: CloneIdentity = browseIdentityFromState(
      state({
        primary: "gh-cli",
        sources: {
          openshipApp: { connected: false },
          ghCli: { available: true, login: "ryan", method: "device" },
        },
      }),
    );
    expect(identity).toEqual({ login: "ryan", method: "device" });
  });

  it("names a pasted PAT separately from host gh", () => {
    expect(
      browseIdentityFromState(
        state({
          primary: "gh-cli",
          sources: {
            openshipApp: { connected: false },
            ghCli: { available: true, login: "ops", method: "token" },
          },
        }),
      ),
    ).toEqual({ login: "ops", method: "pat" });
  });

  it("browses as the App when that is primary", () => {
    expect(
      browseIdentityFromState(
        state({
          primary: "openship-app",
          sources: {
            openshipApp: { connected: true, login: "openship-bot" },
            ghCli: { available: false },
          },
        }),
      ),
    ).toEqual({ login: "openship-bot", method: "app" });
  });
});
