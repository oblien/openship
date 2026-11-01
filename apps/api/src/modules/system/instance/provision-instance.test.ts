import { describe, expect, it, vi } from "vitest";
import type { ExecutionContext, PlatformKernel } from "@repo/platform";
import type { TCreateServiceBody } from "@repo/contracts";
import { installControllerServices } from "./provision-instance";

describe("control-plane installation through the shared engine", () => {
  it.each(["desktop", "browser"] as const)(
    "installs %s access with persistent data and protected authentication",
    async (access) => {
      const specifications: TCreateServiceBody[] = [];
      const create = vi.fn(async (_ctx, _project, spec: TCreateServiceBody) => {
        specifications.push(spec);
        return { data: { id: `service-${spec.name}` } };
      });
      const setEnvVars = vi.fn(async () => {});
      const kernel = { services: { create, setEnvVars } } as unknown as PlatformKernel;
      const ctx = { userId: "owner", organizationId: "org" } as ExecutionContext;
      const plan = {
        organizationId: "org",
        serverId: "selected-server",
        access,
        domain: { kind: "custom" as const, hostname: "ops.example.com" },
        version: "1.2.3",
      };
      const address = await installControllerServices(
        kernel,
        ctx,
        "controller-project",
        plan,
        (purpose) => `private-${purpose}`,
        [],
      );
      const api = specifications.find((service) => service.name === "api")!;
      expect(api.image).toBe("ghcr.io/oblien/openship-api:1.2.3");
      expect(api.volumes).toEqual(["instance-data:/data"]);
      expect(api.environment).toMatchObject({
        PGLITE_DATA_DIR: "/data",
        OPENSHIP_AUTH_MODE: "local",
        OPENSHIP_REQUIRE_AUTH: "true",
        OPENSHIP_ALLOW_ZERO_AUTH: "false",
        OPENSHIP_HOST_CONTROL: "false",
        OPENSHIP_INSTANCE_PROJECT_ID: "controller-project",
      });
      expect(JSON.stringify(specifications)).not.toContain("private-");
      expect(setEnvVars).toHaveBeenCalledWith(
        ctx,
        "controller-project",
        "service-api",
        expect.objectContaining({
          vars: expect.arrayContaining([
            { key: "BETTER_AUTH_SECRET", value: "private-encryption", isSecret: true },
            { key: "OPENSHIP_INSTANCE_RECEIVE_TOKEN", value: "private-bootstrap", isSecret: true },
          ]),
        }),
      );
      if (access === "desktop") {
        expect(specifications).toHaveLength(1);
        expect(api).toMatchObject({
          exposed: true,
          exposedPort: "4000",
          customDomain: "ops.example.com",
        });
        expect(address).toBe("https://ops.example.com");
      } else {
        expect(api.exposed).toBe(false);
        expect(specifications[1]).toMatchObject({
          name: "dashboard",
          exposedPort: "3001",
          dependsOn: ["api"],
          environment: { INTERNAL_API_URL: "http://api:4000" },
        });
        expect(address).toBe("https://ops.example.com/api/proxy");
      }
      // Resuming preparation reuses the same service identities and secret keys.
      create.mockClear();
      await installControllerServices(
        kernel,
        ctx,
        "controller-project",
        plan,
        (purpose) => `private-${purpose}`,
        specifications.map((spec) => ({ id: `service-${spec.name}`, name: spec.name })),
      );
      expect(create).not.toHaveBeenCalled();
    },
  );

  it("uses normal free-route fields for the selected server", async () => {
    const create = vi.fn(async () => ({ data: { id: "api" } }));
    const kernel = {
      services: { create, setEnvVars: vi.fn(async () => {}) },
    } as unknown as PlatformKernel;
    expect(
      await installControllerServices(
        kernel,
        {} as ExecutionContext,
        "project",
        {
          organizationId: "org",
          serverId: "managed",
          access: "desktop",
          domain: { kind: "free", hostname: "my-instance" },
          version: "1.2.3",
        },
        () => "secret",
        [],
      ),
    ).toBe("https://my-instance.opsh.io");
    expect(create).toHaveBeenCalledWith(
      expect.anything(),
      "project",
      expect.objectContaining({ domainType: "free", domain: "my-instance", exposedPort: "4000" }),
    );
  });
});
