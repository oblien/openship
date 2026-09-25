import { describe, expect, it } from "vitest";
import { assertSshSettings, cloudflareSshUrl, normalizeSshTransport } from "../src/ssh-options";

describe("structured SSH transport", () => {
  it("keeps older servers on direct SSH", () => {
    expect(normalizeSshTransport(undefined)).toBe("direct");
    expect(normalizeSshTransport(null)).toBe("direct");
    expect(normalizeSshTransport("cloudflare")).toBe("cloudflare");
  });
  it.each(["ssh", "proxy", "cloudflared access ssh", {}, 1])("rejects unsupported transport %j", value => {
    expect(() => normalizeSshTransport(value)).toThrow();
  });
  it("uses an HTTPS application URL with no path, credentials or command syntax", () => {
    expect(cloudflareSshUrl("SSH.Example.com")).toBe("https://ssh.example.com/");
    expect(() => assertSshSettings({ sshHost: "ssh.example.com", sshTransport: "cloudflare" })).not.toThrow();
  });
  it.each(["127.0.0.1", "::1", "localhost", "https://ssh.example.com", "user@ssh.example.com", "ssh.example.com/a", "ssh.example.com:443", "$(touch /tmp/pwned)", "%h.example.com", "host\n.example.com", "host;.example.com"])("refuses invalid Access hostname %s", host => {
    expect(() => cloudflareSshUrl(host)).toThrow();
  });
  it("refuses conflicting routes and retains the raw-option execution guard", () => {
    const settings = { sshHost: "ssh.example.com", sshTransport: "cloudflare" };
    expect(() => assertSshSettings({ ...settings, sshJumpHost: "bastion.example.com" })).toThrow(/either/);
    expect(() => assertSshSettings({ ...settings, sshArgs: "-oProxyCommand=touch${IFS}/tmp/pwned" })).toThrow(/Unsupported/);
  });
});
