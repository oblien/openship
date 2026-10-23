import { AppError, sanitizeDomainProxySettings } from "@repo/core";
import { repos } from "@repo/db";

/** Imported or previously saved overrides must not silently disappear on Cloud. */
export async function assertDomainProxyTarget(
  project: { id: string },
  target: string | null | undefined,
) {
  if (target !== "cloud" && target !== "cluster") return;
  if (
    (await repos.domain.listByProject(project.id)).some((domain) =>
      sanitizeDomainProxySettings(domain.proxy),
    )
  )
    throw new AppError(
      "This project has domain request body limits. Keep a self-hosted nginx/OpenResty edge, or clear the domain overrides before changing targets.",
      409,
      "DOMAIN_PROXY_SETTINGS_UNSUPPORTED",
    );
}
