import { getChangelog } from "@/lib/changelog";

// Exposes the same repo-driven changelog the pages render, as JSON, for any
// external consumer. Short-cached like the pages.
export const revalidate = 600;

export async function GET() {
  return Response.json(await getChangelog());
}
