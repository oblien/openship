import { parseDeploySource } from "@repo/core";
import { getRepositoryBranding } from "@/lib/repository-branding";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  let source;
  try {
    if (
      params.getAll("repo").length !== 1 ||
      params.getAll("branch").length > 1 ||
      params.has("app")
    )
      throw new Error("Invalid repository reference");
    source = parseDeploySource({
      repo: params.get("repo"),
      branch: params.get("branch") ?? undefined,
    });
    if (source.kind !== "repo") throw new Error("Invalid repository reference");
  } catch {
    // diagnostics-ignore: invalid public query parameters are expected input errors.
    return Response.json(
      { display: null },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const { display, maxAge } = await getRepositoryBranding(source);
  return Response.json(
    { display },
    {
      headers: {
        "Cache-Control": `public, max-age=${Math.min(300, maxAge)}, s-maxage=${maxAge}`,
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
