import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { cloudFrom, getCloudPricing, UI } from "@/lib/pricing";
import { CLOUD_SLA } from "@/lib/cloud-service";
import { cloudPlanHref } from "@/lib/cloud-links";

function models(from: string | null) {
  return [
    {
      n: "01",
      tag: "Managed",
      title: "Openship Cloud",
      lead: "A shared CPU, RAM and storage pool for your projects. Deploy apps, databases, and workers within your plan’s capacity.",
      points: [
        "Resources shared across projects and builds",
        `${CLOUD_SLA.monthlyUptimePercent}% monthly uptime guarantee`,
        "Email and in-app support included",
      ],
      price: from ? `From ${from}${UI.perMonth}` : "See Cloud plans",
      priceNote: "Monthly or annual billing",
      cta: "Start on Cloud",
      href: cloudPlanHref(),
    },
    {
      n: "02",
      tag: "Self-hosted",
      title: "Your servers",
      lead: "Run the entire platform on machines you own. Any Linux box, any provider, any region. Add nodes as you grow.",
      points: [
        "Connect any VPS - Hetzner, DO, AWS, bare metal",
        "Multi-server fan-out across regions",
        "No agent or dashboard on your boxes",
      ],
      price: "Free & open-source",
      priceNote: "Apache-2.0 — self-host today, no billing",
      cta: "Start self-hosting",
      href: "/docs/getting-started/quickstart",
      feature: true,
    },
    {
      n: "03",
      tag: "Hybrid",
      title: "Mix and match",
      lead: "Cloud for the burst, your servers for sensitive data. One control plane. Move workloads without rebuilding.",
      points: [
        "Apps on your servers, services on the cloud",
        "Or production locally, previews managed",
        "One billing, one team, one dashboard",
      ],
      price: "Cloud plan + your servers",
      priceNote: "One Cloud subscription, unlimited self-hosted boxes",
      cta: "Explore hybrid",
      href: "/docs/guides/cloud-workspaces#use-cloud-from-self-hosted-openship",
    },
  ];
}

export async function DeploymentModels() {
  const pricing = await getCloudPricing();
  const MODELS = models(cloudFrom(pricing));
  return (
    <section id="hosting" className="dm-section" aria-labelledby="hosting-title">
      <div className="site-container dm-container">
        <header className="dm-head">
          <p className="dm-eyebrow">Where it runs</p>
          <h2 id="hosting-title" className="dm-title">
            Cloud, self-hosted,
            <br />
            or both.
          </h2>
          <p className="dm-sub">
            Same platform, three deployment shapes - and you can switch any day.
          </p>
          <Link href="/pricing#plans" className="th-btn dm-pricing-cta">
            View pricing <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </header>

        <div className="dm-grid">
          {MODELS.map((m) => (
            <article key={m.n} className={`dm-panel ${m.feature ? "dm-panel--feature" : ""}`}>
              <div className="dm-panel-top">
                <span className="dm-panel-n">{m.n}</span>
                <span className="dm-panel-tag">{m.tag}</span>
              </div>

              <h3 className="dm-panel-title">{m.title}</h3>
              <p className="dm-panel-lead">{m.lead}</p>

              <ul className="dm-panel-points">
                {m.points.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>

              <div className="dm-panel-foot">
                <span className="dm-panel-price">{m.price}</span>
                <span className="dm-panel-pricenote">{m.priceNote}</span>
                <Link href={m.href} className="th-btn dm-panel-cta">
                  {m.cta} <ArrowRight className="size-4" aria-hidden="true" />
                </Link>
              </div>
            </article>
          ))}
        </div>

        {/* ── Migration callout ────────────────────────────────────── */}
        <div className="dm-migrate">
          <div className="dm-migrate-left">
            <span className="dm-migrate-tag">Migrate any day</span>
            <h3 className="dm-migrate-title">
              Cloud{" "}
              <span className="dm-migrate-arrow" aria-hidden="true">
                ⇄
              </span>{" "}
              self-hosted.
              <br />
              <span className="dm-migrate-soft">One click, any time.</span>
            </h3>
          </div>
          <p className="dm-migrate-body">
            Your apps are plain containers and your services are standard images. Move workloads
            between Openship Cloud and your own servers without rebuilding, rewriting, or paying an
            exit tax. Click, confirm, done.
          </p>
        </div>
      </div>
    </section>
  );
}
