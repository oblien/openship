import { describe, expect, it } from "vitest";
import type { CommandExecutor } from "../../../types";
import { scanNginx } from "./nginx";

describe("domain body-limit configuration read-back", () => {
  it.each([undefined, "1m"])(
    "keeps a password location's 4k cap independent of server value %s",
    async (cap) => {
      const config = `http {
      client_max_body_size 50m;
      server {
        server_name events.example.com;
        ${cap ? `client_max_body_size ${cap};` : ""}
        location = /_openship/login { client_max_body_size 4k; proxy_pass http://127.0.0.1:4000; }
        location / { proxy_read_timeout 300s; proxy_pass http://127.0.0.1:3000; }
      }
    }`;
      const exec = { exec: async () => config } as unknown as CommandExecutor;
      const report = await scanNginx(exec);
      expect(report.sites).toHaveLength(1);
      expect(report.sites[0]!.proxy?.clientMaxBodySize).toBe(cap);
      expect(report.sites[0]!.proxyRaw?.clientMaxBodySize).toBe(cap);
      expect(report.sites[0]!.proxy?.proxyReadTimeout).toBe("300s");
      expect(report.sites[0]!.routes?.map((route) => route.path)).toEqual([
        "/_openship/login",
        "/",
      ]);
    },
  );
});
