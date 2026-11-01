import { expect, it } from "vitest";
import { canManageMailServers } from "./mail-availability";

it.each([
  { selfHosted: false, deployMode: "cloud", allowed: false },
  { selfHosted: false, deployMode: "docker", allowed: false },
  { selfHosted: true, deployMode: "docker", allowed: true },
  { selfHosted: true, deployMode: "bare", allowed: true },
  { selfHosted: false, deployMode: "desktop", allowed: true },
])(
  "mail-server management follows the instance capability: $selfHosted / $deployMode",
  ({ allowed, ...platform }) => {
    expect(canManageMailServers(platform)).toBe(allowed);
  },
);
