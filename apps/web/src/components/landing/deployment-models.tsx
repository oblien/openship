import type { Copy } from "@/i18n/copy";
import { getLocale } from "next-intl/server";

import { getCopy } from "@/i18n/copy-server";
import { Link } from "@/i18n/Link";
import { ArrowRight } from "lucide-react";
import { cloudFrom, getCloudPricing, UI } from "@/lib/pricing";
import { CLOUD_SLA } from "@/lib/cloud-service";
import { cloudPlanHref } from "@/lib/cloud-links";

function models(from: string | null, copy: Copy) {
  return [
    {
      n: "01",
      tag: copy("Managed"),
      title: copy("OpenShip Cloud"),
      lead: copy(
        "A shared CPU, RAM and storage pool for your projects. Deploy apps, databases, and workers within your plan’s capacity.",
      ),
      points: [
        copy("Resources shared across projects and builds"),
        copy("{value0}% monthly uptime guarantee", {
          value0: String(CLOUD_SLA.monthlyUptimePercent),
        }),
        copy("Email and in-app support included"),
      ],
      price: from
        ? copy("From {value0}{value1}", { value0: String(from), value1: String(UI.perMonth) })
        : copy("See Cloud plans"),
      priceNote: copy("Monthly or annual billing"),
      cta: copy("Start on Cloud"),
      href: cloudPlanHref(),
    },
    {
      n: "02",
      tag: copy("Self-hosted"),
      title: copy("Your servers"),
      lead: copy(
        "Run the entire platform on machines you own. Any Linux box, any provider, any region. Add nodes as you grow.",
      ),
      points: [
        copy("Connect any VPS - Hetzner, DO, AWS, bare metal"),
        copy("Multi-server fan-out across regions"),
        copy("No agent or dashboard on your boxes"),
      ],
      price: copy("Free & open-source"),
      priceNote: copy("Apache-2.0 — self-host today, no billing"),
      cta: copy("Start self-hosting"),
      href: "/docs/getting-started/quickstart",
      feature: true,
    },
    {
      n: "03",
      tag: copy("Hybrid"),
      title: copy("Mix and match"),
      lead: copy(
        "Cloud for the burst, your servers for sensitive data. One control plane. Move workloads without rebuilding.",
      ),
      points: [
        copy("Apps on your servers, services on the cloud"),
        copy("Or production locally, previews managed"),
        copy("One billing, one team, one dashboard"),
      ],
      price: copy("Cloud plan + your servers"),
      priceNote: copy("One Cloud subscription, unlimited self-hosted boxes"),
      cta: copy("Explore hybrid"),
      href: "/docs/guides/cloud-workspaces#use-cloud-from-self-hosted-openship",
    },
  ];
}

export async function DeploymentModels() {
  const copy = await getCopy();

  const pricing = await getCloudPricing(await getLocale());
  const MODELS = models(cloudFrom(pricing), copy);
  return (
    <section id="hosting" className="dm-section" aria-labelledby="hosting-title">
      <div className="site-container dm-container">
        <header className="dm-head">
          <p className="dm-eyebrow">{copy("Where it runs")}</p>
          <h2 id="hosting-title" className="dm-title">
            {copy("Cloud, self-hosted,")}
            <br />
            {copy("or both.")}
          </h2>
          <p className="dm-sub">
            {copy("Same platform, three deployment shapes - and you can switch any day.")}
          </p>
          <Link href="/pricing#plans" className="th-btn dm-pricing-cta">
            {copy("View pricing ")}
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </header>

        <div className="dm-grid">
          {MODELS.map((m) => (
            <article key={m.n} className={`dm-panel ${m.feature ? "dm-panel--feature" : ""}`}>
              <div className="dm-panel-top">
                <span className="dm-panel-n">{copy(m.n)}</span>
                <span className="dm-panel-tag">{copy(m.tag)}</span>
              </div>

              <h3 className="dm-panel-title">{copy(m.title)}</h3>
              <p className="dm-panel-lead">{copy(m.lead)}</p>

              <ul className="dm-panel-points">
                {m.points.map((p) => (
                  <li key={p}>{copy(p)}</li>
                ))}
              </ul>

              <div className="dm-panel-foot">
                <span className="dm-panel-price">{copy(m.price)}</span>
                <span className="dm-panel-pricenote">{copy(m.priceNote)}</span>
                <Link href={m.href} className="th-btn dm-panel-cta">
                  {copy(m.cta)} <ArrowRight className="size-4" aria-hidden="true" />
                </Link>
              </div>
            </article>
          ))}
        </div>

        {/* ── Migration callout ────────────────────────────────────── */}
        <div className="dm-migrate">
          <div className="dm-migrate-left">
            <span className="dm-migrate-tag">{copy("Migrate any day")}</span>
            <h3 className="dm-migrate-title">
              {copy("Cloud")}{" "}
              <span className="dm-migrate-arrow" aria-hidden="true">
                ⇄
              </span>{" "}
              {copy("self-hosted.")}
              <br />
              <span className="dm-migrate-soft">{copy("One click, any time.")}</span>
            </h3>
          </div>
          <p className="dm-migrate-body">
            {copy(
              "Your apps are plain containers and your services are standard images. Move workloads between OpenShip Cloud and your own servers without rebuilding, rewriting, or paying an exit tax. Click, confirm, done.",
            )}
          </p>
        </div>
      </div>
    </section>
  );
}
