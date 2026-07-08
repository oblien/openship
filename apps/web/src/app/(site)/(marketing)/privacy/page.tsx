import type { Metadata } from "next";
import { Navbar, Footer } from "@/components/landing";

const PAGE_TITLE = "Privacy Policy";
const PAGE_DESCRIPTION =
  "How Openship handles your data. What we collect, why, where it lives, how to remove it. We do not sell personal data and we do not show ads.";

export const metadata: Metadata = {
  title: PAGE_TITLE,
  description: PAGE_DESCRIPTION,
  alternates: { canonical: "/privacy" },
  openGraph: {
    title: `${PAGE_TITLE} - Openship`,
    description: PAGE_DESCRIPTION,
    url: "/privacy",
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
    id: "overview",
    title: "Overview",
    body: [
      "Openship is a deployment platform. We host code, secrets, and infrastructure on your behalf when you use Openship Cloud. When you self-host, everything stays on your own machines and this policy applies only to the parts of our service you interact with (account, billing, support).",
      "This policy describes what we collect, why, where it lives, and how to remove it. We do not sell personal data. We do not show ads.",
    ],
  },
  {
    id: "what-we-collect",
    title: "What we collect",
    body: [
      "Account data - email, hashed password (or OAuth identity), team name, and your role.",
      "Billing data - for Cloud and Business plans only. Card and tax details are processed by Stripe; we store the last four digits and the invoice history.",
      "Project metadata - repository URL, branch, build commands, environment variable names (not values), domain names, deployment timestamps.",
      "Build artifacts - container images we built on your behalf. Stored for the lifetime of the deployment and pruned by our retention policy.",
      "Logs - application and build logs, retained 30 days on Cloud, 12 months on Business.",
      "Telemetry - off by default. If you opt in we collect anonymous platform-version and feature-usage events to inform the roadmap.",
    ],
  },
  {
    id: "what-we-dont",
    title: "What we don't collect",
    body: [
      "Source code outside of build time - we fetch your repo, build, and discard the working tree. The image is what persists.",
      "Decrypted secrets - environment variables are encrypted at rest with keys we never log.",
      "Customer data flowing through your apps. Your databases and your application logs are your data; we host them but we don't read them.",
      "Behavioural analytics on your end users.",
    ],
  },
  {
    id: "where-it-lives",
    title: "Where data lives",
    body: [
      "Cloud customers - primary storage in EU-West (Ireland) with replicas in US-East and AP-South. You can pin a project to a single region.",
      "Self-hosted customers - everything stays on the machines you run. We have zero visibility.",
      "Backups - encrypted, region-pinned, 30-day rolling window on Cloud, extended retention on Business.",
    ],
  },
  {
    id: "third-parties",
    title: "Third-party processors",
    body: [
      "Stripe - payment processing and invoicing.",
      "AWS, Hetzner, Cloudflare - infrastructure providers for compute, network, and edge.",
      "Postmark - outbound transactional email (account events, billing receipts).",
      "Sentry - error reporting, with PII scrubbing enabled.",
      "We do not use marketing trackers, advertising pixels, or session replay tools.",
    ],
  },
  {
    id: "rights",
    title: "Your rights",
    body: [
      "Access - request an export of everything we have about you, in machine-readable form.",
      "Deletion - delete your account at any time; we erase identifying data within 30 days and retain only what's required by tax law.",
      "Portability - every deployment is a plain container image and a standard manifest. You can leave Cloud and re-run on your own servers without rewriting anything.",
      "Contact privacy@openship.io for any of the above. We respond within 5 business days.",
    ],
  },
  {
    id: "changes",
    title: "Changes",
    body: [
      "When this policy materially changes we email account owners at least 14 days before the change takes effect, with a side-by-side diff of what's changing and why.",
    ],
  },
];

export default function PrivacyPage() {
  return (
    <>
      <Navbar />
      <main className="legal-root">

        <section className="legal-hero">
          <div className="legal-container">
            <p className="legal-eyebrow">Privacy</p>
            <h1 className="legal-title">
              How we<br />
              <span className="legal-title-soft">handle your data.</span>
            </h1>
            <p className="legal-meta">
              Last updated <time dateTime="2026-05-18">May&nbsp;18, 2026</time>
              <span className="legal-meta-sep">·</span>
              <a href="https://github.com/openship/openship/commits/main/PRIVACY.md" className="legal-meta-link" target="_blank" rel="noreferrer">
                Version history on GitHub
              </a>
            </p>
          </div>
        </section>

        <section className="legal-body">
          <div className="legal-container">
            <div className="legal-grid">
              {/* Table of contents */}
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

              {/* Article */}
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
                    Questions or requests? Email{" "}
                    <a href="mailto:privacy@openship.io">privacy@openship.io</a>.
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
