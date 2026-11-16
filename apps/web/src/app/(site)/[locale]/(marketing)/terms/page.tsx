import type { Copy } from "@/i18n/copy";
import { localizedMetadata } from "@/i18n/metadata";
import { useCopy } from "@/i18n/use-copy";

import type { Metadata, ResolvingMetadata } from "next";
import { inheritSocialImages } from "@/lib/social-metadata";
import { Navbar, Footer } from "@/components/landing";
import { getSlaSections } from "@/components/marketing/sla-terms";

const PAGE_TITLE = "Terms of Service";
const PAGE_DESCRIPTION =
  "Terms governing OpenShip Cloud and OpenShip Business. The self-hosted platform itself is governed by the Apache 2.0 license. Plain language, no surprises.";

const metadata: Metadata = {
  title: PAGE_TITLE,
  description: PAGE_DESCRIPTION,
  alternates: { canonical: "/terms" },
  openGraph: {
    title: `${PAGE_TITLE} - OpenShip`,
    description: PAGE_DESCRIPTION,
    url: "/terms",
    type: "article",
  },
  twitter: {
    card: "summary_large_image",
    title: `${PAGE_TITLE} - OpenShip`,
    description: PAGE_DESCRIPTION,
  },
};

export async function generateMetadata(
  _props: unknown,
  parent: ResolvingMetadata,
): Promise<Metadata> {
  return localizedMetadata(await inheritSocialImages(metadata, parent));
}

function getSections(copy: Copy) {
  return [
    {
      id: "agreement",
      title: copy("Agreement"),
      body: [
        copy(
          "These terms govern your use of OpenShip Cloud (the hosted service) and OpenShip Business (managed Cloud and connected servers). The self-hosted platform itself is governed by the Apache 2.0 license that ships with the source.",
        ),
        copy(
          "By creating an account you agree to these terms. If you're using OpenShip on behalf of an organisation, you confirm you have authority to bind that organisation.",
        ),
      ],
    },
    {
      id: "the-service",
      title: copy("The service"),
      body: [
        copy(
          "We provide infrastructure to build, ship, and run your applications - managed databases, mail, storage, routing, and the platform tooling around it.",
        ),
        copy(
          "OpenShip Cloud resource pool plans cover purchased CPU, RAM and storage for the paid period. Separately priced services and retained storage after that period follow the terms shown in Billing. Existing metered subscriptions keep their saved terms. Self-hosted use is free under the Apache 2.0 license.",
        ),
        copy(
          "We may improve the service, fix bugs, or evolve features at any time. Material breaking changes get at least 30 days' notice.",
        ),
      ],
    },
    {
      id: "your-account",
      title: copy("Your account"),
      body: [
        copy(
          "You're responsible for keeping your credentials safe and for what's done under your account. Notify us promptly of any suspected unauthorised use.",
        ),
        copy(
          "You won't share login credentials, attempt to bypass usage limits, or interfere with other customers' workloads on shared infrastructure.",
        ),
      ],
    },
    {
      id: "your-content",
      title: copy("Your content"),
      body: [
        copy(
          "You own your code, your data, your domain names, and everything you ship through the platform. You grant us only the permissions we need to run your service - fetch your repo, build images, route traffic, store backups, deliver mail.",
        ),
        copy(
          "You're responsible for ensuring you have rights to whatever you deploy. We don't review user content; we may take action only when a clear legal violation is reported (DMCA, sanctions, CSAM).",
        ),
      ],
    },
    {
      id: "acceptable-use",
      title: copy("Acceptable use"),
      body: [
        copy(
          "No targeted attacks on infrastructure (yours or anyone else's), no spam relay, no crypto mining, no malware distribution, no sanctions-list workloads.",
        ),
        copy(
          "Heavy outbound mail must use verified domains with reputable opt-in flows. Repeated bounce or spam complaints will trigger a deliverability review.",
        ),
        copy(
          "If we suspend a workload for acceptable-use reasons you'll get an immediate notice with a path to remediation. Permanent termination is reserved for clear, repeat, or severe violations.",
        ),
      ],
    },
    {
      id: "billing",
      title: copy("Billing"),
      body: [
        copy(
          "OpenShip Cloud plan prices are published on our pricing page. Paid plans are billed monthly in advance and you may cancel at any time; cancellation takes effect at the end of the period you have already paid for. Self-hosted use is free.",
        ),
        copy(
          "We accept major cards via Stripe. Price changes to a plan you are on are announced at least 30 days in advance and apply from your next billing period. A failed payment triggers retries and email notice before any suspension.",
        ),
      ],
    },
    ...getSlaSections(copy),
    {
      id: "data-portability",
      title: copy("Data portability"),
      body: [
        copy(
          "Every deployment on OpenShip is a plain container image and standard manifests. You can leave any day and re-run on your own infrastructure without rewriting code.",
        ),
        copy(
          "On request we provide a full export of your databases, secrets, and configuration in standard formats. We do not charge for exports.",
        ),
      ],
    },
    {
      id: "warranty",
      title: copy("Warranty disclaimer"),
      body: [
        copy(
          "Except for the express commitments in the Cloud SLA above or a separate written agreement, the service is provided “as is”. We disclaim implied warranties of merchantability and fitness for a particular purpose to the maximum extent permitted by law.",
        ),
        copy(
          "The Cloud SLA remains applicable, but it is not a promise of uninterrupted or error-free service, or that the service will meet every specific requirement.",
        ),
      ],
    },
    {
      id: "liability",
      title: copy("Limitation of liability"),
      body: [
        copy(
          "To the maximum extent permitted by law, neither party is liable for indirect, incidental, or consequential damages.",
        ),
        copy(
          "Our total liability under these terms is capped at the fees you paid us in the 12 months preceding the claim. Self-hosted users - for whom we charge nothing - have a corresponding cap.",
        ),
      ],
    },
    {
      id: "termination",
      title: copy("Termination"),
      body: [
        copy(
          "You may cancel at any time from your account settings. We may terminate accounts that materially violate these terms, with notice and an opportunity to cure where reasonable.",
        ),
        copy(
          "On termination we delete identifying data within 30 days, except where retention is legally required (tax, dispute records).",
        ),
      ],
    },
    {
      id: "law",
      title: copy("Governing law"),
      body: [
        copy(
          "These terms are governed by the laws of Ireland. Disputes are resolved in the courts of Dublin, except where applicable law grants you the right to bring proceedings in your local courts.",
        ),
      ],
    },
    {
      id: "changes",
      title: copy("Changes to these terms"),
      body: [
        copy(
          "When we make material changes we email account owners at least 14 days in advance. Continued use after the effective date is acceptance; if you disagree, cancellation triggers a prorated refund of any unused prepaid time.",
        ),
      ],
    },
  ];
}

export default function TermsPage() {
  const copy = useCopy();
  const SECTIONS = getSections(copy);

  return (
    <>
      <Navbar />
      <main className="legal-root">
        <section className="legal-hero">
          <div className="legal-container">
            <p className="legal-eyebrow">{copy("Terms of service")}</p>
            <h1 className="legal-title">
              {copy("The rules")}
              <br />
              <span className="legal-title-soft">{copy("in plain words.")}</span>
            </h1>
            <p className="legal-meta">
              {copy("Last updated ")}
              <time dateTime="2026-11-10">{copy("November 10, 2026")}</time>
              <span className="legal-meta-sep">·</span>
              <a
                href="https://github.com/oblien/openship/commits/main/apps/web/src/app/(site)/[locale]/(marketing)/terms/page.tsx"
                className="legal-meta-link"
                target="_blank"
                rel="noreferrer"
              >
                {copy("Version history on GitHub")}
              </a>
            </p>
          </div>
        </section>

        <section className="legal-body">
          <div className="legal-container">
            <div className="legal-grid">
              <aside className="legal-toc" aria-label={copy("Table of contents")}>
                <p className="legal-toc-title">{copy("On this page")}</p>
                <ol>
                  {SECTIONS.map((s, i) => (
                    <li key={s.id}>
                      <a href={`#${s.id}`}>
                        <span className="legal-toc-n">{String(i + 1).padStart(2, "0")}</span>
                        {copy(s.title)}
                      </a>
                    </li>
                  ))}
                </ol>
              </aside>

              <article className="legal-article">
                {SECTIONS.map((s, i) => (
                  <section key={s.id} id={s.id} className="legal-section">
                    <header className="legal-section-head">
                      <span className="legal-section-n">{String(i + 1).padStart(2, "0")}</span>
                      <h2 className="legal-section-title">{copy(s.title)}</h2>
                    </header>
                    {s.body.map((p, j) => (
                      <p key={j} className="legal-p">
                        {copy(p)}
                      </p>
                    ))}
                  </section>
                ))}

                <footer className="legal-foot">
                  <p>
                    {copy("Questions? Email ")}
                    <a href="mailto:legal@openship.io">{copy("legal@openship.io")}</a>.
                  </p>
                </footer>
              </article>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
