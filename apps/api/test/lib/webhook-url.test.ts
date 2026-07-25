import { describe, expect, it } from "vitest";
import { assertPublicWebhookUrl } from "../../src/lib/notification-workers";

describe("assertPublicWebhookUrl", () => {
  it("accepts valid public HTTPS URLs", () => {
    expect(() => assertPublicWebhookUrl("https://hooks.example.com/webhook")).not.toThrow();
    expect(() => assertPublicWebhookUrl("https://discord.com/api/webhooks/123/abc")).not.toThrow();
    expect(() => assertPublicWebhookUrl("https://hooks.slack.com/services/T00/B00/xxx")).not.toThrow();
  });

  it("rejects HTTP URLs", () => {
    expect(() => assertPublicWebhookUrl("http://hooks.example.com/webhook")).toThrow("must use HTTPS");
  });

  it("rejects localhost", () => {
    expect(() => assertPublicWebhookUrl("https://localhost/webhook")).toThrow("private or loopback");
    expect(() => assertPublicWebhookUrl("https://localhost:8080/hook")).toThrow("private or loopback");
  });

  it("rejects loopback IPv4", () => {
    expect(() => assertPublicWebhookUrl("https://127.0.0.1/webhook")).toThrow("private or loopback");
    expect(() => assertPublicWebhookUrl("https://127.0.0.2/webhook")).toThrow("private or loopback");
  });

  it("rejects loopback IPv6", () => {
    expect(() => assertPublicWebhookUrl("https://[::1]/webhook")).toThrow("private or loopback");
  });

  it("rejects private 10.x.x.x", () => {
    expect(() => assertPublicWebhookUrl("https://10.0.0.1/webhook")).toThrow("private or loopback");
    expect(() => assertPublicWebhookUrl("https://10.255.255.255/hook")).toThrow("private or loopback");
  });

  it("rejects private 192.168.x.x", () => {
    expect(() => assertPublicWebhookUrl("https://192.168.1.1/webhook")).toThrow("private or loopback");
    expect(() => assertPublicWebhookUrl("https://192.168.0.100/hook")).toThrow("private or loopback");
  });

  it("rejects private 172.16-31.x.x", () => {
    expect(() => assertPublicWebhookUrl("https://172.16.0.1/hook")).toThrow("private or loopback");
    expect(() => assertPublicWebhookUrl("https://172.31.255.255/hook")).toThrow("private or loopback");
  });

  it("allows 172.32.x.x (public range)", () => {
    expect(() => assertPublicWebhookUrl("https://172.32.0.1/hook")).not.toThrow();
  });

  it("rejects link-local 169.254.x.x", () => {
    expect(() => assertPublicWebhookUrl("https://169.254.1.1/hook")).toThrow("private or loopback");
  });

  it("rejects 0.0.0.0", () => {
    expect(() => assertPublicWebhookUrl("https://0.0.0.0/hook")).toThrow("private or loopback");
  });

  it("rejects .local TLD", () => {
    expect(() => assertPublicWebhookUrl("https://my-service.local/hook")).toThrow("private or loopback");
  });

  it("rejects malformed URLs", () => {
    expect(() => assertPublicWebhookUrl("not-a-url")).toThrow("malformed");
    expect(() => assertPublicWebhookUrl("")).toThrow("malformed");
  });
});
