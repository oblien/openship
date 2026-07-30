import { describe, expect, it } from "vitest";
import { inferSwarmRoutingUrls, readSwarmRoutingLabels } from "./swarm-routing-labels";

describe("Swarm routing label metadata", () => {
  it("exposes recognised router labels only and redacts credential-like values", () => {
    expect(readSwarmRoutingLabels({
      "traefik.enable": "true",
      "traefik.http.routers.web.rule": "Host(`app.example.test`)",
      "traefik.http.middlewares.auth.basicauth.password": "not-for-the-ui",
      "app.version": "2026.7",
    })).toEqual([
      { key: "traefik.enable", value: "true", redacted: false },
      { key: "traefik.http.middlewares.auth.basicauth.password", value: null, redacted: true },
      { key: "traefik.http.routers.web.rule", value: "Host(`app.example.test`)", redacted: false },
    ]);
  });

  it("infers safe https URLs from recognised host rules", () => {
    const labels = readSwarmRoutingLabels({
      "traefik.http.routers.web.rule": "Host(`App.Example.test`)",
      caddy: "api.example.test",
      "traefik.http.routers.unsafe.rule": "Host(`example.test`); service=unix:/tmp/socket",
    });
    expect(inferSwarmRoutingUrls(labels)).toEqual([
      "https://api.example.test",
      "https://app.example.test",
    ]);
  });
});
