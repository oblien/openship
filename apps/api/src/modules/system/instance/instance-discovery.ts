import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { z } from "zod";
import { AppError, instanceOrigin } from "@repo/core";

const identitySchema = z.object({
  protocol: z.literal(1),
  installationId: z.string().uuid(),
  origin: z.string(),
});

/** A person can enter the dashboard URL or the API-only URL. Probe only the
 * two Openship mounts on that reviewed HTTPS origin, without credentials or
 * redirects. The public identity chooses no account and grants no authority. */
export async function discoverInstance(value: string) {
  const origin = instanceOrigin(value);
  const candidates = origin.endsWith("/api/proxy") ? [origin] : [origin, `${origin}/api/proxy`];
  const signal = AbortSignal.timeout(15_000);
  for (const candidate of candidates) {
    let response: Response;
    try {
      response = await fetch(`${candidate}/api/system/instance/identity`, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal,
      });
    } catch (diagnosticFailure) {
      observeCaughtError(diagnosticFailure, "api/modules/system/instance/instance-discovery");
      break;
    }
    if (!response.ok) {
      await response.body?.cancel();
      // A dashboard's root API mount may not exist. An unavailable or denied
      // endpoint is a real failure, not permission to look for another server.
      if ([404, 405].includes(response.status)) continue;
      break;
    }
    const identity = identitySchema.safeParse(await response.json().catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "api/modules/system/instance/instance-discovery"); return null; }));
    if (!identity.success) continue;
    if (identity.data.origin !== candidate)
      throw new AppError("Use the address configured on the remote instance.", 409);
    return identity.data;
  }
  throw new AppError(
    "Could not connect to Openship at this address. Check that the instance is online and its HTTPS address is correct.",
    409,
  );
}
