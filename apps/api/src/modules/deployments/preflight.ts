/**
 * Pre-deploy checks — validate prerequisites before the build pipeline starts.
 *
 * Called after the user clicks Deploy but BEFORE any build work begins.
 * If any check fails, the deployment is rejected with actionable errors —
 * no resources are provisioned, no build session started.
 *
 * Checks are mode-aware (determined by snapshot flags):
 *   - hasBuild=true:   validate install/build commands
 *   - hasServer=true:  validate port + start command
 *   - Both false:      plain static files, minimal checks
 *
 * Domain check: if a custom domain is provided, verifies the CNAME record
 * points to edge.openship.io before allowing the build to start.
 */

import type { DeploymentConfigSnapshot } from "./build.service";
import { platform } from "../../lib/controller-helpers";
import type { CloudRuntime } from "@repo/adapters";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PreflightCheck {
    id: string;
    label: string;
    status: "pass" | "fail" | "warn";
    message?: string;
}

export interface PreflightResult {
    ok: boolean;
    checks: PreflightCheck[];
}

export interface PreflightOptions {
    customDomain?: string;
    /** Free subdomain slug to validate format (e.g. "my-app" → my-app.opsh.io) */
    slug?: string;
}

// ─── Individual checks ──────────────────────────────────────────────────────

/** Validate that all required config fields are present based on mode. */
function checkConfig(snapshot: DeploymentConfigSnapshot): PreflightCheck {
    const missing: string[] = [];

    if (!snapshot.repoUrl) missing.push("repository URL");
    if (!snapshot.branch) missing.push("branch");
    if (!snapshot.buildImage) missing.push("build image");

    // Build mode requires install command
    if (snapshot.hasBuild) {
        if (!snapshot.installCommand) missing.push("install command");
    }

    // Server mode requires start command and port
    if (snapshot.hasServer) {
        if (!snapshot.startCommand) missing.push("start command");
        if (!snapshot.port) missing.push("port");
    }

    if (missing.length > 0) {
        return {
            id: "config",
            label: "Build configuration",
            status: "fail",
            message: `Missing required fields: ${missing.join(", ")}`,
        };
    }

    return { id: "config", label: "Build configuration", status: "pass" };
}

/** Validate stack-specific requirements based on hasBuild + hasServer. */
function checkStack(snapshot: DeploymentConfigSnapshot): PreflightCheck {
    if (!snapshot.hasServer && snapshot.startCommand) {
        return {
            id: "stack",
            label: "Stack configuration",
            status: "warn",
            message: "Static site has a start command configured — it will be ignored. Files will be served from the edge.",
        };
    }

    if (snapshot.hasBuild && !snapshot.buildCommand) {
        return {
            id: "stack",
            label: "Stack configuration",
            status: "warn",
            message: "Build is enabled but no build command configured — deployment will use source files directly.",
        };
    }

    if (!snapshot.hasBuild && snapshot.buildCommand) {
        return {
            id: "stack",
            label: "Stack configuration",
            status: "warn",
            message: "Build is disabled but a build command exists — it will be skipped.",
        };
    }

    return { id: "stack", label: "Stack configuration", status: "pass" };
}

/**
 * Verify a custom domain's DNS configuration.
 * Uses Oblien SDK domain.validate() in cloud mode, local DNS in self-hosted.
 * Skipped for free .opsh.io subdomains.
 */
async function checkDomain(customDomain: string): Promise<PreflightCheck> {
    const { target, runtime } = platform();

    // Cloud mode: use Oblien SDK for DNS validation
    if (target === "cloud") {
        try {
            const cloud = runtime as CloudRuntime;
            const result = await cloud.validateDomain(customDomain);

            if (result.verified) {
                return { id: "domain", label: "Domain DNS", status: "pass" };
            }

            const errorMsg = result.errors.length > 0
                ? result.errors.join("; ")
                : `DNS not configured for ${customDomain}. Add a CNAME record pointing to ${result.requiredRecords.cname.target}`;

            return {
                id: "domain",
                label: "Domain DNS",
                status: "fail",
                message: errorMsg,
            };
        } catch {
            // Fall through to local check if Oblien validation fails
        }
    }

    // Self-hosted / fallback: local DNS CNAME check
    try {
        const dns = await import("node:dns/promises");
        const records = await dns.resolveCname(customDomain);
        const pointsToEdge = records.some(
            (r) => r.toLowerCase() === "edge.openship.io",
        );

        if (pointsToEdge) {
            return { id: "domain", label: "Domain DNS", status: "pass" };
        }

        return {
            id: "domain",
            label: "Domain DNS",
            status: "fail",
            message: `CNAME for ${customDomain} does not point to edge.openship.io. Current target: ${records.join(", ") || "none"}`,
        };
    } catch {
        return {
            id: "domain",
            label: "Domain DNS",
            status: "fail",
            message: `No CNAME record found for ${customDomain}. Add a CNAME record pointing to edge.openship.io`,
        };
    }
}

// ─── Main entry point ───────────────────────────────────────────────────────

/** Validate slug format for subdomain use (slug.opsh.io). */
function checkSlugFormat(slug: string): PreflightCheck {
    if (slug.length < 1 || slug.length > 63) {
        return {
            id: "slug",
            label: "Subdomain",
            status: "fail",
            message: `Slug must be between 1 and 63 characters (got ${slug.length}).`,
        };
    }

    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(slug)) {
        return {
            id: "slug",
            label: "Subdomain",
            status: "fail",
            message: `"${slug}" is not a valid subdomain. Use only lowercase letters, numbers, and hyphens. Must start and end with a letter or number.`,
        };
    }

    return { id: "slug", label: "Subdomain", status: "pass" };
}

/** Verify that cloud runtime credentials are valid and the account is active. */
async function checkCloudRuntime(): Promise<PreflightCheck> {
    const { target, runtime } = platform();
    if (target !== "cloud") {
        return { id: "runtime", label: "Runtime", status: "pass" };
    }

    try {
        const cloud = runtime as CloudRuntime;
        await cloud.getQuota();
        return { id: "runtime", label: "Cloud runtime", status: "pass" };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
            id: "runtime",
            label: "Cloud runtime",
            status: "fail",
            message: `Cannot connect to cloud runtime: ${msg}`,
        };
    }
}

/**
 * Run all pre-deploy checks for a config snapshot.
 *
 * Returns { ok, checks } — ok is false if ANY check has status "fail".
 * Warnings don't block deployment.
 */
export async function runPreflightChecks(
    snapshot: DeploymentConfigSnapshot,
    opts?: PreflightOptions,
): Promise<PreflightResult> {
    const checks: PreflightCheck[] = [
        checkConfig(snapshot),
        checkStack(snapshot),
    ];

    // Validate slug format for free subdomain
    if (opts?.slug) {
        checks.push(checkSlugFormat(opts.slug));
    }

    // Verify cloud runtime credentials are working
    checks.push(await checkCloudRuntime());

    // If custom domain provided, verify DNS before starting the build
    if (opts?.customDomain) {
        checks.push(await checkDomain(opts.customDomain));
    }

    return {
        ok: checks.every((c) => c.status !== "fail"),
        checks,
    };
}
