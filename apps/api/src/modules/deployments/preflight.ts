/**
 * Pre-deploy checks — validate prerequisites before the build pipeline starts.
 *
 * Called after the user clicks Deploy but BEFORE any build work begins.
 * If any check fails, the deployment is rejected with actionable errors —
 * no resources are provisioned, no build session started.
 *
 * Cloud checks are SaaS-owned:
 *   - SaaS mode calls the shared cloud preflight service directly
 *   - Desktop/local mode calls the SaaS preflight endpoint
 *   - Local/desktop never talks to Oblien directly for preflight
 */

import type { DeploymentConfigSnapshot } from "./build.service";
import { platform } from "../../lib/controller-helpers";
import { SYSTEM } from "@repo/core";
import { getCloudPreflight } from "../../lib/cloud-client";
import type { CloudPreflightData } from "../../lib/cloud-preflight";

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
    slug?: string;
    userId?: string;
}

async function resolveCloudPreflight(
    snapshot: DeploymentConfigSnapshot,
    opts?: PreflightOptions,
): Promise<CloudPreflightData | null> {
    const plat = platform();
    const effectiveTarget = plat.target === "desktop"
        ? snapshot.deployTarget ?? "cloud"
        : plat.target;

    if (effectiveTarget !== "cloud" || !opts?.userId) {
        return null;
    }

    if (plat.target === "cloud") {
        const { runCloudPreflight } = await import("../../lib/cloud-preflight");
        return runCloudPreflight(opts.userId, {
            slug: opts.slug,
            customDomain: opts.customDomain,
        });
    }

    return getCloudPreflight(opts.userId, {
        slug: opts.slug,
        customDomain: opts.customDomain,
    });
}

function checkConfig(snapshot: DeploymentConfigSnapshot): PreflightCheck {
    const missing: string[] = [];

    if (!snapshot.repoUrl && !snapshot.localPath) missing.push("repository URL or local path");
    if (!snapshot.branch && !snapshot.localPath) missing.push("branch");
    if (!snapshot.buildImage) missing.push("build image");

    if (snapshot.hasBuild && !snapshot.installCommand) {
        missing.push("install command");
    }

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

function checkStack(snapshot: DeploymentConfigSnapshot): PreflightCheck {
    if (!snapshot.hasServer && snapshot.startCommand) {
        return {
            id: "stack",
            label: "Stack configuration",
            status: "warn",
            message: "Static site has a start command configured - it will be ignored. Files will be served from the edge.",
        };
    }

    if (snapshot.hasBuild && !snapshot.buildCommand) {
        return {
            id: "stack",
            label: "Stack configuration",
            status: "warn",
            message: "Build is enabled but no build command configured - deployment will use source files directly.",
        };
    }

    if (!snapshot.hasBuild && snapshot.buildCommand) {
        return {
            id: "stack",
            label: "Stack configuration",
            status: "warn",
            message: "Build is disabled but a build command exists - it will be skipped.",
        };
    }

    return { id: "stack", label: "Stack configuration", status: "pass" };
}

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

async function checkSlug(slug: string, cloud: CloudPreflightData | null): Promise<PreflightCheck> {
    if (!cloud) {
        return { id: "slug-available", label: "Subdomain availability", status: "pass" };
    }

    if (!cloud.runtime.ok) {
        return {
            id: "slug-available",
            label: "Subdomain availability",
            status: "warn",
            message: "Could not verify subdomain availability",
        };
    }

    if (cloud.slug?.available === false) {
        return {
            id: "slug-available",
            label: "Subdomain availability",
            status: "fail",
            message: cloud.slug.message ?? `"${slug}.${SYSTEM.DOMAINS.CLOUD_DOMAIN}" is already taken. Choose a different subdomain.`,
        };
    }

    if (cloud.slug?.message) {
        return {
            id: "slug-available",
            label: "Subdomain availability",
            status: "warn",
            message: cloud.slug.message,
        };
    }

    return { id: "slug-available", label: "Subdomain availability", status: "pass" };
}

async function checkCustomDomain(
    customDomain: string,
    cloud: CloudPreflightData | null,
): Promise<PreflightCheck> {
    if (cloud?.runtime.ok && cloud.customDomain) {
        if (cloud.customDomain.verified) {
            if (cloud.customDomain.message) {
                return { id: "domain", label: "Domain DNS", status: "warn", message: cloud.customDomain.message };
            }
            return { id: "domain", label: "Domain DNS", status: "pass" };
        }

        return {
            id: "domain",
            label: "Domain DNS",
            status: "fail",
            message: cloud.customDomain.message ?? `DNS not configured for ${customDomain}`,
        };
    }

    try {
        const dns = await import("node:dns/promises");
        const records = await dns.resolveCname(customDomain);
        const pointsToEdge = records.some((record) => record.toLowerCase() === "edge.openship.io");

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

async function checkCloudRuntime(cloud: CloudPreflightData | null): Promise<PreflightCheck> {
    if (!cloud) {
        return { id: "runtime", label: "Runtime", status: "pass" };
    }

    if (cloud.runtime.ok) {
        return { id: "runtime", label: "Cloud runtime", status: "pass" };
    }

    return {
        id: "runtime",
        label: "Cloud runtime",
        status: "fail",
        message: cloud.runtime.message,
    };
}

export async function runPreflightChecks(
    snapshot: DeploymentConfigSnapshot,
    opts?: PreflightOptions,
): Promise<PreflightResult> {
    const cloudPreflight = await resolveCloudPreflight(snapshot, opts);
    const checks: PreflightCheck[] = [
        checkConfig(snapshot),
        checkStack(snapshot),
    ];

    if (opts?.slug && !opts?.customDomain) {
        checks.push(checkSlugFormat(opts.slug));
        checks.push(await checkSlug(opts.slug, cloudPreflight));
    }

    checks.push(await checkCloudRuntime(cloudPreflight));

    if (opts?.customDomain) {
        checks.push(await checkCustomDomain(opts.customDomain, cloudPreflight));
    }

    return {
        ok: checks.every((check) => check.status !== "fail"),
        checks,
    };
}
