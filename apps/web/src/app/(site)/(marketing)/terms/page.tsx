import type { Metadata } from "next";
import { Navbar, Footer } from "@/components/landing";

const PAGE_TITLE = "Terms of Service";
const PAGE_DESCRIPTION =
  "Terms governing Openship Cloud and Openship Business. The self-hosted platform itself is governed by AGPL-3.0. Plain language, no surprises.";

export const metadata: Metadata = {
  title: PAGE_TITLE,
  description: PAGE_DESCRIPTION,
  alternates: { canonical: "/terms" },
  openGraph: {
    title: `${PAGE_TITLE} - Openship`,
    description: PAGE_DESCRIPTION,
    url: "/terms",
    type: "article",
  },
  twitter: {
    card: "summary_large_image",
    title: `${PAGE_TITLE} - Openship`,
    description: PAGE_DESCRIPTION,
  },
};

const SECTIONS = [
  {
    id: "agreement",
    title: "Agreement",
    body: [
      "These terms govern your use of Openship Cloud (the hosted service) and Openship Business (cloud + your servers + SLA). The self-hosted platform itself is governed by the AGPL-3.0 license that ships with the source.",
      "By creating an account you agree to these terms. If you're using Openship on behalf of an organisation, you confirm you have authority to bind that organisation.",
    ],
  },
  {
    id: "the-service",
    title: "The service",
    body: [
      "We provide infrastructure to build, ship, and run your applications - managed databases, mail, storage, routing, and the platform tooling around it.",
      "Cloud has free allowances for compute and bandwidth. Beyond those, usage is metered and billed in arrears. Per-seat pricing applies to active team members each month.",
      "We may improve the service, fix bugs, or evolve features at any time. Material breaking changes get at least 30 days' notice.",
    ],
  },
  {
    id: "your-account",
    title: "Your account",
    body: [
      "You're responsible for keeping your credentials safe and for what's done under your account. Notify us promptly of any suspected unauthorised use.",
      "You won't share login credentials, attempt to bypass usage limits, or interfere with other customers' workloads on shared infrastructure.",
    ],
  },
  {
    id: "your-content",
    title: "Your content",
    body: [
      "You own your code, your data, your domain names, and everything you ship through the platform. You grant us only the permissions we need to run your service - fetch your repo, build images, route traffic, store backups, deliver mail.",
      "You're responsible for ensuring you have rights to whatever you deploy. We don't review user content; we may take action only when a clear legal violation is reported (DMCA, sanctions, CSAM).",
    ],
  },
  {
    id: "acceptable-use",
    title: "Acceptable use",
    body: [
      "No targeted attacks on infrastructure (yours or anyone else's), no spam relay, no crypto mining, no malware distribution, no sanctions-list workloads.",
      "Heavy outbound mail must use verified domains with reputable opt-in flows. Repeated bounce or spam complaints will trigger a deliverability review.",
      "If we suspend a workload for acceptable-use reasons you'll get an immediate notice with a path to remediation. Permanent termination is reserved for clear, repeat, or severe violations.",
    ],
  },
  {
    id: "billing",
    title: "Billing",
    body: [
      "Cloud is per-seat per month, billed monthly. Yearly billing prices in 20% discount. Usage overages (compute, bandwidth) are billed in arrears with itemised invoices.",
      "We accept major cards via Stripe. Invoices are also available for Business plans.",
      "If a charge fails we retry, then email account owners. Persistent failure pauses deploys after 14 days; data is retained 30 more days before deletion.",
      "Refunds: unused prepaid time is refunded prorated within 30 days of cancellation. Usage charges are non-refundable.",
    ],
  },
  {
    id: "uptime-sla",
    title: "Uptime and SLA",
    body: [
      "Cloud targets 99.9% monthly uptime on a best-effort basis. Business plans receive a 99.9% contractual SLA with service credits as the sole remedy.",
      "Scheduled maintenance is announced at least 7 days in advance and excluded from uptime calculations.",
    ],
  },
  {
    id: "data-portability",
    title: "Data portability",
    body: [
      "Every deployment on Openship is a plain container image and standard manifests. You can leave any day and re-run on your own infrastructure without rewriting code.",
      "On request we provide a full export of your databases, secrets, and configuration in standard formats. We do not charge for exports.",
    ],
  },
  {
    id: "warranty",
    title: "Warranty disclaimer",
    body: [
      "The service is provided “as is”. We disclaim implied warranties of merchantability and fitness for a particular purpose to the maximum extent permitted by law.",
      "We make no warranty that the service will be uninterrupted, error-free, or meet your specific requirements - though we try our hardest.",
    ],
  },
  {
    id: "liability",
    title: "Limitation of liability",
    body: [
      "To the maximum extent permitted by law, neither party is liable for indirect, incidental, or consequential damages.",
      "Our total liability under these terms is capped at the fees you paid us in the 12 months preceding the claim. Self-hosted users - for whom we charge nothing - have a corresponding cap.",
    ],
  },
  {
    id: "termination",
    title: "Termination",
    body: [
      "You may cancel at any time from your account settings. We may terminate accounts that materially violate these terms, with notice and an opportunity to cure where reasonable.",
      "On termination we delete identifying data within 30 days, except where retention is legally required (tax, dispute records).",
    ],
  },
  {
    id: "law",
    title: "Governing law",
    body: [
      "These terms are governed by the laws of Ireland. Disputes are resolved in the courts of Dublin, except where applicable law grants you the right to bring proceedings in your local courts.",
    ],
  },
  {
    id: "changes",
    title: "Changes to these terms",
    body: [
      "When we make material changes we email account owners at least 14 days in advance. Continued use after the effective date is acceptance; if you disagree, cancellation triggers a prorated refund of any unused prepaid time.",
    ],
  },
];

export default function TermsPage() {
  return (
    <>
      <Navbar />
      <main className="legal-root">

        <section className="legal-hero">
          <div className="legal-container">
            <p className="legal-eyebrow">Terms of service</p>
            <h1 className="legal-title">
              The rules<br />
              <span className="legal-title-soft">in plain words.</span>
            </h1>
            <p className="legal-meta">
              Last updated <time dateTime="2026-05-18">May&nbsp;18, 2026</time>
              <span className="legal-meta-sep">·</span>
              <a href="https://github.com/openship/openship/commits/main/TERMS.md" className="legal-meta-link" target="_blank" rel="noreferrer">
                Version history on GitHub
              </a>
            </p>
          </div>
        </section>

        <section className="legal-body">
          <div className="legal-container">
            <div className="legal-grid">
              <aside className="legal-toc" aria-label="Table of contents">
                <p className="legal-toc-title">On this page</p>
                <ol>
                  {SECTIONS.map((s, i) => (
                    <li key={s.id}>
                      <a href={`#${s.id}`}>
                        <span className="legal-toc-n">{String(i + 1).padStart(2, "0")}</span>
                        {s.title}
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
                      <h2 className="legal-section-title">{s.title}</h2>
                    </header>
                    {s.body.map((p, j) => (
                      <p key={j} className="legal-p">{p}</p>
                    ))}
                  </section>
                ))}

                <footer className="legal-foot">
                  <p>
                    Questions? Email{" "}
                    <a href="mailto:legal@openship.io">legal@openship.io</a>.
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
