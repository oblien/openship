import { expect, it } from "vitest";
import { normalizeComposeServices } from "../src/compose";

it("preserves private shared memory for CLI and SDK Compose sync", () => {
  const [service] = normalizeComposeServices({ services: { vllm: { image: "vllm:test", shm_size: "2g", gpus: "all" } } }, "/tmp");
  expect(service?.advanced?.shmSize).toBe(2147483648);
  expect(() => normalizeComposeServices({ services: { vllm: { image: "vllm:test", shm_size: "wrong" } } }, "/tmp")).toThrow(/cannot deploy faithfully/);
});

it("keeps Compose host mappings in the SDK sync payload", () => {
  const [service] = normalizeComposeServices(
    {
      services: {
        webmail: { image: "webmail:test", extra_hosts: { "mail.example.com": "host-gateway" } },
      },
    },
    "/tmp",
  );
  expect(service?.advanced?.extraHosts).toEqual({ "mail.example.com": "host-gateway" });
});
it("refuses invalid Compose host mappings instead of dropping them", () => {
  expect(() =>
    normalizeComposeServices(
      { services: { webmail: { image: "webmail:test", extra_hosts: { mail: "invalid" } } } },
      "/tmp",
    ),
  ).toThrow(/addresses/);
});

it("retains every GPU group and the legacy runtime in SDK/CLI Compose sync", () => {
  const [service] = normalizeComposeServices(
    {
      services: {
        inference: {
          image: "nvidia/cuda",
          runtime: "nvidia",
          environment: { NVIDIA_VISIBLE_DEVICES: "0" },
          deploy: {
            resources: {
              reservations: {
                devices: [{ driver: "nvidia", device_ids: ["0"], capabilities: ["gpu"] }],
              },
            },
          },
          gpus: [{ driver: "nvidia", device_ids: ["1"] }],
        },
      },
    },
    "/tmp",
  );
  expect(service?.advanced).toMatchObject({
    runtime: "nvidia",
    gpus: [
      { driver: "nvidia", deviceIds: ["0"], capabilities: ["gpu"] },
      { driver: "nvidia", deviceIds: ["1"], capabilities: ["gpu"] },
    ],
  });
  expect(service?.environment).toEqual({ NVIDIA_VISIBLE_DEVICES: "0" });
});

it.each([
  { driver: "amd", count: 1 },
  { driver: "nvidia", count: "wrong" },
  { device_ids: ["0"], count: 1 },
  { device_ids: ["example.com/host-device=root"] },
])("refuses invalid GPU selectors before CLI sync can upload partial configuration", (request) => {
  expect(() =>
    normalizeComposeServices(
      { services: { inference: { image: "nvidia/cuda", gpus: [request] } } },
      "/tmp",
    ),
  ).toThrow(/cannot deploy faithfully/);
});
