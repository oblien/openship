import { getDeploymentInfoOrNull } from "@/lib/server/session";
import { ApiUnavailable } from "@/components/api-unavailable";
import { SupportCenter } from "@/components/support/SupportCenter";

export default async function SupportPage() {
  const deployment = await getDeploymentInfoOrNull();
  if (!deployment) return <ApiUnavailable />;
  return <SupportCenter />;
}
