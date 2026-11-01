import { expect, it, vi } from "vitest";
import { OpenshipClient } from "../src";

it("preserves the monitor URL by default and sends the opt-in usage format", async () => {
  const fetcher = vi.fn(
    async () =>
      new Response('event: usage\ndata: {"cpuPercent":12}\n\n', {
        headers: { "content-type": "text/event-stream" },
      }),
  );
  const ship = new OpenshipClient({
    baseUrl: "https://openship.test",
    token: "test-token",
    fetch: fetcher,
  });
  for await (const _event of ship.servers.monitor("server-a")) {
    /* consume the response */
  }
  for await (const _event of ship.servers.monitor("server-a", { format: "usage" })) {
    /* consume the response */
  }
  expect(String(fetcher.mock.calls[0]?.[0])).toBe(
    "https://openship.test/api/system/monitor/stream?serverId=server-a",
  );
  expect(String(fetcher.mock.calls[1]?.[0])).toBe(
    "https://openship.test/api/system/monitor/stream?serverId=server-a&format=usage",
  );
});
