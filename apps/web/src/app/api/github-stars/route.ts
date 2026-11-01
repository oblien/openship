import { reportCaughtError } from "@repo/core/diagnostics";

export async function GET() {
  try {
    const response = await fetch("https://api.github.com/repos/oblien/openship", {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Openship",
      },
      next: { revalidate: 3600 },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
    const { stargazers_count: stars } = await response.json();
    if (!Number.isSafeInteger(stars) || stars < 0) {
      throw new Error("GitHub returned an invalid star count");
    }
    return Response.json(
      { stars },
      { headers: { "Cache-Control": "public, max-age=3600, s-maxage=3600" } },
    );
  } catch (error) {
    reportCaughtError(error, "web/api/github-stars");
    return Response.json(
      { stars: null },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
