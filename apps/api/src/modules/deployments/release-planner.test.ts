import { describe, expect, it } from "vitest";
import {
  planAndSelectTrigger,
  planRelease,
  selectReleaseTrigger,
} from "./release-planner";

const PREFIXED_SERVICES = [
  { id: "svc_staff", name: "staff", rootDirectory: "apps/staff" },
  { id: "svc_public", name: "public", rootDirectory: "apps/public" },
  { id: "svc_mail", name: "mail", rootDirectory: "apps/mail" },
];

const mounted = { mountedReleaseEnabled: true, services: PREFIXED_SERVICES };

describe("planRelease", () => {
  it("classifies a mounted project Blade/PHP change as deploy_code", () => {
    const plan = planRelease({
      ...mounted,
      changedPaths: [
        "apps/staff/resources/views/home.blade.php",
        "apps/staff/app/Http/Controllers/HomeController.php",
      ],
    });
    expect(plan.action).toBe("deploy_code");
    expect(plan.reason).toMatch(/Blade|application/i);
    expect(plan.serviceIds).toEqual(["svc_staff"]);
    expect(selectReleaseTrigger(plan, true)).toBe("mounted_release");
  });

  it("classifies a mounted project Dockerfile change as rebuild_runtime", () => {
    const plan = planRelease({
      ...mounted,
      changedPaths: ["apps/staff/Dockerfile"],
    });
    expect(plan.action).toBe("rebuild_runtime");
    expect(plan.reason).toMatch(/Dockerfile|Compose/i);
    expect(plan.serviceIds).toEqual(["svc_staff"]);
    expect(selectReleaseTrigger(plan, true)).toBe("runtime_pipeline");
  });

  it("does not target staff when only apps/public changes", () => {
    const plan = planRelease({
      ...mounted,
      changedPaths: ["apps/public/resources/views/welcome.blade.php"],
      routedServiceIds: ["svc_staff", "svc_public", "svc_mail"],
    });
    expect(plan.action).toBe("deploy_code");
    expect(plan.serviceIds).toEqual(["svc_public"]);
    expect(plan.serviceIds).not.toContain("svc_staff");
    expect(plan.serviceIds).not.toContain("svc_mail");
  });

  it("skips docs-only changes", () => {
    const plan = planRelease({
      ...mounted,
      changedPaths: ["docs/runbook.md", "README.md"],
    });
    expect(plan.action).toBe("skip");
    expect(plan.reason).toMatch(/documentation|unrelated/i);
    expect(selectReleaseTrigger(plan, true)).toBe("skip");
  });

  it("still uses the runtime pipeline when mounted releases are off", () => {
    const { plan, trigger } = planAndSelectTrigger({
      mountedReleaseEnabled: false,
      services: PREFIXED_SERVICES,
      changedPaths: ["apps/staff/resources/views/home.blade.php"],
    });
    expect(plan.action).toBe("deploy_code");
    expect(trigger).toBe("runtime_pipeline");
    expect(selectReleaseTrigger(plan, false)).toBe("runtime_pipeline");
  });

  it("notes composer.lock as a code deploy that needs the Composer layer", () => {
    const plan = planRelease({
      ...mounted,
      changedPaths: ["apps/staff/composer.lock"],
    });
    expect(plan.action).toBe("deploy_code");
    expect(plan.reason).toMatch(/composer\.lock/i);
    expect(plan.reason).toMatch(/Composer layer/i);
    expect(plan.serviceIds).toEqual(["svc_staff"]);
  });

  it("deploys git-tracked env or route files as code, not an env-table refresh", () => {
    const { plan, trigger } = planAndSelectTrigger({
      ...mounted,
      changedPaths: ["apps/public/.env.production", "apps/public/Caddyfile"],
    });
    expect(plan.action).toBe("deploy_code");
    expect(plan.reason).toMatch(/commit/i);
    expect(plan.serviceIds).toEqual(["svc_public"]);
    expect(trigger).toBe("mounted_release");
  });

  it("keeps refresh_config only for an explicit refresh request", () => {
    const plan = planRelease({
      ...mounted,
      changedPaths: ["apps/public/Caddyfile"],
      refreshRequested: true,
    });
    expect(plan.action).toBe("refresh_config");
  });

  it("rebuilds runtime for PHP extension files", () => {
    const plan = planRelease({
      ...mounted,
      changedPaths: ["docker/php/conf.d/extensions.ini"],
    });
    expect(plan.action).toBe("rebuild_runtime");
    expect(plan.reason).toMatch(/PHP extensions/i);
    expect(plan.serviceIds).toBeUndefined();
  });

  it("skips an unrelated monorepo app when those prefixes are bound", () => {
    const plan = planRelease({
      ...mounted,
      changedPaths: ["apps/other/src/index.php"],
    });
    expect(plan.action).toBe("skip");
  });

  it("does not bind a default prefix from service.name when rootDirectory is another tree", () => {
    const { plan, trigger } = planAndSelectTrigger({
      mountedReleaseEnabled: true,
      services: [{ id: "svc_web", name: "public", rootDirectory: "frontend" }],
      changedPaths: ["apps/api/index.php"],
    });
    expect(plan.action).toBe("deploy_code");
    expect(trigger).toBe("mounted_release");
    expect(plan.serviceIds).toBeUndefined();
  });

  it("targets every bound prefix on a mixed push even when routing missed one", () => {
    const plan = planRelease({
      mountedReleaseEnabled: true,
      services: [
        { id: "svc_staff", name: "staff", rootDirectory: "apps/staff" },
        { id: "svc_public", name: "public", rootDirectory: null },
      ],
      routedServiceIds: ["svc_staff"],
      changedPaths: [
        "apps/staff/resources/views/home.blade.php",
        "apps/public/resources/views/welcome.blade.php",
      ],
    });
    expect(plan.action).toBe("deploy_code");
    expect(plan.serviceIds).toEqual(["svc_staff", "svc_public"]);
  });

  it("does not treat application PHP as a PHP-extension rebuild", () => {
    const { plan, trigger } = planAndSelectTrigger({
      ...mounted,
      changedPaths: ["apps/staff/app/Services/PhpExtractor.php"],
    });
    expect(plan.action).toBe("deploy_code");
    expect(trigger).toBe("mounted_release");
    expect(plan.serviceIds).toEqual(["svc_staff"]);
  });

  it("treats compose override files as a runtime rebuild", () => {
    const { plan, trigger } = planAndSelectTrigger({
      ...mounted,
      changedPaths: ["apps/staff/docker-compose.override.yml"],
    });
    expect(plan.action).toBe("rebuild_runtime");
    expect(trigger).toBe("runtime_pipeline");
    expect(plan.serviceIds).toEqual(["svc_staff"]);
  });

  it("does not skip apps/public on a single-app project with no matching services", () => {
    const plan = planRelease({
      mountedReleaseEnabled: true,
      services: [],
      changedPaths: ["apps/public/resources/views/home.blade.php"],
    });
    expect(plan.action).toBe("deploy_code");
    expect(plan.serviceIds).toBeUndefined();
  });

  it("treats unknown paths as a code deploy unless force-all", () => {
    expect(
      planRelease({ ...mounted, changedPaths: null }).action,
    ).toBe("deploy_code");
    expect(
      planRelease({ ...mounted, changedPaths: null, forceAll: true }).action,
    ).toBe("rebuild_runtime");
  });
});
