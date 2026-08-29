import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * `targetServiceIds` is a BUILD subset. `strictScope` is an EXCLUSION. Conflating them
 * loses data.
 *
 * The difference only shows up when there is no previous release. `targetServiceIds` spares
 * an untargeted service by CARRYING IT FORWARD, and carry has exactly one source —
 * `previousByServiceId`, built from `project.activeDeploymentId`. A project with no active
 * deployment cannot carry anything, so an untargeted service that is `enabled` and holds an
 * image falls straight through to a normal deploy.
 *
 * That is precisely the migration's adopt-in-place shape: the reuse rows are enabled, they
 * carry the running image, and their `service_deployment` rows are written by
 * `attachLiveRuntime` only AFTER the deploy. Scoping with `serviceIds` alone therefore
 * deployed them — a SECOND container on the still-running originals' bare volumes (reuse
 * rows keep `namespaceVolumes: false`), i.e. two writers on one dataset. `strictScope` is
 * what makes them untouchable, and it now reaches the pipeline through the snapshot.
 *
 * Driving `deployComposeServices` needs a runtime, a docker host and a repo layer, so this
 * pins the WIRING as a source contract — the same approach `proxy-settings-wiring.test.ts`
 * takes for this file. `service-scope.test.ts` covers the pure predicates; it cannot cover
 * this case, because `isUntargetedAndUndeployable` is FALSE here (the row has an image).
 */
const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

const buildService = src("../build.service.ts");
const pipeline = src("./pipeline.ts");
const deployService = src("./deploy.service.ts");
const orchestrator = src("../../migration/migration.orchestrator.ts");

describe("strictScope reaches the compose deploy from the snapshot", () => {
  it("is persisted onto the snapshot, and only alongside a scope", () => {
    // On its own it would describe an exclusion of nothing.
    expect(buildService).toContain(
      "if (opts.strictServiceScope && opts.serviceIds && opts.serviceIds.length > 0)",
    );
    expect(buildService).toContain("meta = { ...meta, strictServiceScope: true }");
  });

  it("is INTERNAL-only — never a field of the wire body", () => {
    // A client that could set it could scope any project's deploy exclusively.
    expect(buildService).toContain("internal?: { strictServiceScope?: boolean }");
    expect(buildService).toContain("strictServiceScope: internal?.strictServiceScope");
  });

  it("is read off the snapshot and passed into the deploy", () => {
    expect(pipeline).toContain("strictServiceScope?: boolean");
    expect(pipeline).toMatch(/const strictScope =[\s\S]{0,200}strictServiceScope/);
    expect(pipeline).toContain("strictScope,");
  });

  it("requires a scope to mean anything, and never overrides forceAll", () => {
    const at = pipeline.indexOf("const strictScope =");
    const decl = pipeline.slice(at, at + 240);
    expect(decl).toContain("!dep.forceAll");
    expect(decl).toContain("!!targetServiceIds");
  });

  it("makes the deploy SKIP an untargeted service outright", () => {
    // Not "carry it if we can" — `continue`, before any image resolution or create.
    expect(deployService).toContain(
      "if (opts?.strictScope && opts.targetServiceIds && !opts.targetServiceIds.has(svc.id)) {",
    );
  });

  it("the migration asks for it, so its reuse set is untouchable", () => {
    expect(orchestrator).toContain("{ strictServiceScope: true }");
    // And still refuses an empty scope, which requestBuildAccess would drop → deploy all.
    expect(orchestrator).toContain("if (deployRowIds.length === 0)");
  });
});
