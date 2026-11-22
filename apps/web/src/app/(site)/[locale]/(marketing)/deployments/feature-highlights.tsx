import { Link } from "@/i18n/Link";
import { getCopy } from "@/i18n/copy-server";
import { FEATURES, getFeature } from "@/lib/features";
import { FeatureLink } from "../features/_components/FeatureLink";
import { CardMarquee, MarqueeHeading } from "./card-marquee";
import styles from "./feature-highlights.module.css";

const highlightRows = [
  ["preview-deployments", "logs-monitoring", "backups-restore", "instant-rollbacks", "jobs-triggers", "domains-ssl"],
  ["push-to-deploy", "project-topology", "actions-ci", "managed-databases", "secrets-credentials", "persistent-storage"],
  ["edge-routing", "app-catalog", "ai-mcp", "configuration-as-code", "notifications", "team-roles"],
].map((slugs) => slugs.flatMap((slug) => getFeature(slug) ?? []));

export async function FeatureHighlights() {
  const copy = await getCopy();
  return (
    <section className={styles.section} aria-labelledby="platform-features">
      <MarqueeHeading id="platform-features" title={copy("Platform features")}>
        <div className={styles.actions}>
          <Link href="/features" className={styles.explore}>
            {copy("Explore all {count} features", { count: FEATURES.length })} <span aria-hidden="true">→</span>
          </Link>
          <label className={styles.motion}>
            <input type="checkbox" className="sr-only" aria-label={copy("Pause automatic scrolling")} aria-controls="feature-cards" />
            <span aria-hidden="true" />
          </label>
        </div>
      </MarqueeHeading>
      <div id="feature-cards">
        {highlightRows.map((features, index) => (
          <CardMarquee key={index} reverse={index % 2 === 1} renderCards={(duplicate) =>
            features.map((feature) => <FeatureLink key={feature.slug} feature={feature} tabIndex={duplicate ? -1 : undefined} />)
          } />
        ))}
      </div>
    </section>
  );
}
