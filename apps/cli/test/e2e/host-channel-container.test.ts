import { describe, expect, it } from "vitest";
import { checkHostChannel } from "../../src/lib/host-channel-preflight";

// Requires an installed Compose stack with a configured, reachable host SSH channel.
// Run with OPENSHIP_TEST_HOST_CHANNEL=1; never change the host firewall.
describe.skipIf(process.env.OPENSHIP_TEST_HOST_CHANNEL !== "1")("host channel in the API image", () => {
  it("reaches the configured host from the actual API container", async () => {
    const result = await checkHostChannel();
    expect(result.configured).toBe(true);
    expect(result.code).toBe("open");
  });

  it("distinguishes a refused connection from an unavailable probe", async () => {
    const result = await checkHostChannel({
      channel: () => ({ host: "127.0.0.1", port: 1, user: "unused" }),
    });
    expect(result.code).toBe("refused");
  });
});
