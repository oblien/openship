import { redirect } from "next/navigation";

/** Preserve bookmarked history filters at its new Monitoring location. */
export default async function DeploymentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (Array.isArray(value)) value.forEach((item) => query.append(key, item));
    else if (value !== undefined) query.set(key, value);
  }
  query.set("tab", "deployments");
  redirect(`/monitoring?${query}`);
}
