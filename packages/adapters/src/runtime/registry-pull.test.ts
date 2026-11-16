import { expect, it } from "vitest";
import { DeployError } from "@repo/core";
import { registryAccessError } from "./registry-pull";

it.each([
  new Error('Head "https://ghcr.io/v2/org/private/manifests/main": denied: denied'),
  new Error("unauthorized: authentication required"),
  new Error("pull access denied for org/private, repository does not exist or may require docker login"),
  new Error("insufficient_scope: authorization failed"),
  Object.assign(new Error("registry rejected the request"), { statusCode: 403 }),
])("provides actionable recovery for a registry denial: %s", error => {
  const result = registryAccessError("ghcr.io/org/private:main", error);
  expect(result).toBeInstanceOf(DeployError);
  expect(result).toMatchObject({
    code: "REGISTRY_ACCESS_DENIED",
    details: { registry: "ghcr.io", imageRef: "ghcr.io/org/private:main" },
  });
  expect(result?.message).toContain("Settings → Connections → Container registry");
  expect(result?.message).toContain("GitHub clone credentials are separate");
});

it.each([
  new Error("permission denied while trying to connect to the Docker daemon socket"),
  new Error("no space left on device"),
  new Error("manifest unknown"),
  new Error("connection reset by peer"),
  new Error("Command timed out"),
  Object.assign(new Error("rate limited"), { statusCode: 429 }),
])("does not mislabel other failures as a registry credential problem: %s", error => {
  expect(registryAccessError("redis:7", error)).toBeUndefined();
});

it.each([
  ["org/private:1", "docker.io"],
  ["registry.example.com:5000/org/private:1", "registry.example.com:5000"],
])("uses the registry in %s without GitHub-specific instructions", (imageRef, registry) => {
  const result = registryAccessError(imageRef, new Error("unauthorized"));
  expect(result?.details).toEqual({ registry, imageRef });
  expect(result?.message).not.toContain("GitHub");
});

it("does not serialize an SDK error's credential-bearing properties", () => {
  const error = Object.assign(new Error("unauthorized"), { config: { password: "hidden-token" } });
  const result = registryAccessError("ghcr.io/org/private:1", error);
  expect(JSON.stringify(result)).not.toContain("hidden-token");
});
