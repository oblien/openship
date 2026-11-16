import { docEntries } from "@/lib/llms";
import { PRODUCT_SUMMARY } from "@/lib/product";

export const dynamic = "force-static";

export function GET() {
  return new Response(
    [
      "# OpenShip documentation",
      "",
      `> ${PRODUCT_SUMMARY}`,
      "",
      "## Documentation",
      ...docEntries().map(
        (doc) => `- [${doc.title}](${doc.mdUrl})${doc.description ? `: ${doc.description}` : ""}`,
      ),
      "",
    ].join("\n"),
    { headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );
}
