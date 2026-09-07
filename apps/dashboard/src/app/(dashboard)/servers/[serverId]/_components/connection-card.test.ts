import { describe, expect, it } from "vitest";

import { getCloudflareWebTerminalUrl } from "./connection-card";

const cloudflare = (sshHost: string, sshProxyCommand = "cloudflared access ssh --hostname %h") => ({
  sshHost,
  sshProxyCommand,
});

describe("getCloudflareWebTerminalUrl", () => {
  it("opens the public Cloudflare hostname for native cloudflared commands", () => {
    expect(
      getCloudflareWebTerminalUrl(
        cloudflare(
          "ssh.aruntimalsina.com.np",
          '"C:\\Program Files (x86)\\cloudflared\\cloudflared.exe" access ssh --hostname %h',
        ),
      ),
    ).toBe("https://ssh.aruntimalsina.com.np/");
  });

  it("does not expose a web-terminal action for non-Cloudflare proxy commands", () => {
    expect(getCloudflareWebTerminalUrl(cloudflare("ssh.example.com", "ssh -W %h:%p bastion"))).toBeNull();
    expect(getCloudflareWebTerminalUrl(cloudflare("ssh.example.com", null))).toBeNull();
  });

  it("rejects hosts that cannot be used as a public browser-rendered hostname", () => {
    expect(getCloudflareWebTerminalUrl(cloudflare("192.0.2.10"))).toBeNull();
    expect(getCloudflareWebTerminalUrl(cloudflare("ssh.example.com:22"))).toBeNull();
    expect(getCloudflareWebTerminalUrl(cloudflare("user@ssh.example.com"))).toBeNull();
    expect(getCloudflareWebTerminalUrl(cloudflare("ssh.example.com/path"))).toBeNull();
  });
});
