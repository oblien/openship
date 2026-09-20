import type { InfrastructureProviderId } from "@repo/core";
import { Network } from "lucide-react";
import { AppLogo } from "@/components/AppLogo";

// Branding is presentation data; supported providers still come from capabilities.
// Both Hetzner profiles share a mark, with their network type shown by the selector.
const LOGOS = {
  "hetzner-dedicated": "/provider-logos/hetzner.svg",
  "hetzner-cloud": "/provider-logos/hetzner.svg",
  aws: "/provider-logos/aws.svg",
  azure: "/provider-logos/azure.svg",
  gcp: "/provider-logos/gcp.svg",
  digitalocean: "/provider-logos/digitalocean.svg",
  ovh: "/provider-logos/ovh.svg",
  scaleway: "/provider-logos/scaleway.svg",
  custom: undefined,
} satisfies Record<InfrastructureProviderId, string | undefined>;

export function InfrastructureProviderLogo({
  providerId,
}: {
  providerId: InfrastructureProviderId;
}) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex size-6 shrink-0 items-center justify-center rounded-md ${providerId === "custom" ? "bg-muted/50" : "bg-white"}`}
    >
      <AppLogo key={providerId} src={LOGOS[providerId]} icon={Network} className="size-5" />
    </span>
  );
}
