import { describe, expect, it } from "vitest";
import {
  HOST_CHANNEL_BLOCKED,
  HOST_CHANNEL_SYMPTOM,
  HOST_CHANNEL_UNAFFECTED,
} from "@repo/core";
import en from "./locales/en/servers.json";

/**
 * The one seam a shared constant can't close (#490).
 *
 * The CLI preflight, the API boot banner and `openship doctor` all build their impact
 * copy from HOST_CHANNEL_* in @repo/core. This banner can't: its copy has to be
 * translatable, so English lives in the locale file like every other string. Which
 * means the two can drift — and drift here is expensive in a specific way: every line
 * is either "your install is fine, this one feature isn't" or "your install is
 * broken", and an operator who reads the wrong one either tears down a working box or
 * ignores a dead feature for months.
 *
 * So the English string must contain each shared fact VERBATIM. Adding a capability to
 * HOST_CHANNEL_BLOCKED fails here until the banner says it too. Other locales are not
 * checked: they fall back to English per key (see `deepMerge` in ./index), so a
 * missing translation degrades to the correct text rather than a stale one.
 */
describe("servers.banner.hostChannelImpact tracks @repo/core", () => {
  const impact = en.banner.hostChannelImpact;

  it("keeps the reassurance that ordinary deploys are unaffected", () => {
    expect(impact).toContain(HOST_CHANNEL_UNAFFECTED);
  });

  it.each([...HOST_CHANNEL_BLOCKED])("names what stops working: %s", (item) => {
    expect(impact).toContain(item);
  });

  it("names the symptom the operator is looking at", () => {
    expect(impact).toContain(HOST_CHANNEL_SYMPTOM);
  });
});

/**
 * #509: the channel that was never provisioned has no endpoint, so no probe ran.
 * The copy for that state must therefore name no machine at all — the bug it
 * replaced interpolated the row's display host and reported that nothing answered
 * on 127.0.0.1:22. Only the "once provisioned" line takes an address, and it says
 * in words that nothing has contacted it.
 */
describe("servers.banner unprovisioned-channel copy names no machine", () => {
  it("takes no interpolated values at all", () => {
    expect(en.banner.hostChannelMissingBody).not.toMatch(/\{\w+\}/);
  });

  it("frames the address it does show as intent, not as a failed probe", () => {
    expect(en.banner.hostChannelWouldUse).toContain("{target}");
    expect(en.banner.hostChannelWouldUse).toMatch(/nothing has contacted/i);
  });
});
