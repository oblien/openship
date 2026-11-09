import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { APP_CATEGORY_LABELS, type MarketplaceApp } from "@/lib/app-marketplace";
import { MarketplaceLogo } from "./marketplace-logo";

export function AppHostingNote({ app }: { app: MarketplaceApp }) {
  const notes = [
    app.gpu === "required"
      ? "NVIDIA GPU required"
      : app.gpu === "recommended"
        ? "GPU recommended"
        : null,
    !app.supportsCloud ? "Self-hosted only" : null,
  ].filter(Boolean);
  return notes.length ? <p className="marketplace-hosting-note">{notes.join(" · ")}</p> : null;
}

/** Catalog results and related apps share one presentation of catalog metadata. */
export function MarketplaceAppLink({
  app,
  heading: Heading = "h2",
}: {
  app: MarketplaceApp;
  heading?: "h2" | "h3";
}) {
  return (
    <Link href={`/apps/${app.id}`} className="marketing-link marketplace-app-link">
      <MarketplaceLogo id={app.id} logo={app.logo} name={app.name} />
      <div className="marketing-link-copy">
        <Heading>{app.name}</Heading>
        <p className="line-clamp-3">{app.description}</p>
        <span className="marketplace-app-meta">
          {APP_CATEGORY_LABELS[app.category]}
          {!app.available && <span className="marketplace-badge">Coming soon</span>}
          {app.available && app.experimental && (
            <span className="marketplace-badge">Experimental</span>
          )}
        </span>
        <AppHostingNote app={app} />
      </div>
      <ArrowUpRight className="marketing-link-arrow" aria-hidden="true" />
    </Link>
  );
}
