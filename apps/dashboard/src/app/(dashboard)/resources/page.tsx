import { redirect } from "next/navigation";
import { ManagedResourcesPage } from "@/components/resources/ManagedResourcesPage";

/** Keep space bookmarks while the unscoped entry uses the account's plan overview. */
export default async function ResourcesPage({ searchParams }: {
  searchParams: Promise<{ pool?: string }>;
}) {
  const query = await searchParams;
  if (!query.pool) redirect("/billing");
  return <ManagedResourcesPage />;
}
