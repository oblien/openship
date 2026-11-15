import { useCopy } from "@/i18n/use-copy";

import { Link } from "@/i18n/Link";
import { ArrowRight } from "lucide-react";
import { FeatureIllustration, type FeatureIllustrationName } from "@repo/ui/illustrations";
import { FEATURES } from "@/lib/features";
import { DarkSection } from "./dark-section";

const GROUPS = (
  [
    {
      title: "Deploy your stack",
      description: "Applications, databases, and public endpoints in the same project.",
      slugs: ["compose-multi-service", "managed-databases", "domains-ssl"],
    },
    {
      title: "Automate the work",
      description: "Build delivery pipelines, schedule tasks, and connect your AI tools.",
      slugs: ["actions-ci", "jobs-triggers", "ai-mcp"],
    },
    {
      title: "Stay in control",
      description: "Follow service health, protect your data, and recover a previous release.",
      slugs: ["logs-monitoring", "backups-restore", "instant-rollbacks"],
    },
  ] satisfies { title: string; description: string; slugs: FeatureIllustrationName[] }[]
).map((group) => ({
  ...group,
  features: group.slugs.flatMap((slug) => {
    const feature = FEATURES.find((entry) => entry.slug === slug);
    return feature ? [feature] : [];
  }),
}));

export function CompletePlatform() {
  const copy = useCopy();

  return (
    <section id="features" className="cp-outer" aria-labelledby="platform-title">
      <DarkSection>
        <div className="site-container cp-container">
          <header className="cp-head">
            <div>
              <h2 id="platform-title" className="cp-title">
                {copy("Apps, data, and automation.")}
                <br />
                <span>{copy("Run it all from OpenShip.")}</span>
              </h2>
              <p className="cp-sub">
                {copy(
                  "Deploy code, run services, and manage the infrastructure behind them. Use OpenShip Cloud or connect your own servers.",
                )}
              </p>
            </div>
            <Link href="/features" className="cp-all-link">
              {copy("Explore all {count} features", { count: FEATURES.length })}{" "}
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </header>

          <div className="cp-stack">
            {GROUPS.map((group) => (
              <div key={group.title} className="cp-group">
                <div className="cp-group-intro">
                  <h3>{copy(group.title)}</h3>
                  <p>{copy(group.description)}</p>
                </div>
                <div className="cp-grid">
                  {group.features.map((feature) => (
                    <Link key={feature.slug} href={`/features/${feature.slug}`} className="cp-item">
                      <FeatureIllustration name={feature.slug} className="cp-item-art" />
                      <h4>{copy(feature.title)}</h4>
                      <p>{copy(feature.tagline)}</p>
                      <ArrowRight className="cp-item-arrow" aria-hidden="true" />
                    </Link>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="cp-interfaces">
            <span>{copy("Your workflow, your interface.")}</span>
            <Link href="/features/dashboard-cli-desktop">{copy("Dashboard, desktop & CLI")}</Link>
            <Link href="/features/api-sdk">API & SDK</Link>
            <Link href="/features/ai-mcp">AI & MCP</Link>
          </div>
        </div>
      </DarkSection>
    </section>
  );
}
