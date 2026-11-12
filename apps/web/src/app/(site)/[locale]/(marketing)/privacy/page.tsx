import type { Copy } from "@/i18n/copy";
import { localizedMetadata } from "@/i18n/metadata";
import { useCopy } from "@/i18n/use-copy";

import type { Metadata, ResolvingMetadata } from "next";
import { inheritSocialImages } from "@/lib/social-metadata";
import { Navbar, Footer } from "@/components/landing";

const PAGE_TITLE = "Privacy Policy";
const PAGE_DESCRIPTION =
  "How OpenShip handles your data. What we collect, why, where it lives, how to remove it. We do not sell personal data and we do not show ads.";

const metadata: Metadata = {
  title: PAGE_TITLE,
  description: PAGE_DESCRIPTION,
  alternates: { canonical: "/privacy" },
  openGraph: {
    title: `${PAGE_TITLE} - OpenShip`,
    description: PAGE_DESCRIPTION,
    url: "/privacy",
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
      id: "overview",
      title: copy("Overview"),
      body: [
        copy(
          "OpenShip is a deployment platform. We host code, secrets, and infrastructure on your behalf when you use OpenShip Cloud. When you self-host, everything stays on your own machines and this policy applies only to the parts of our service you interact with (account, billing, support).",
        ),
        copy(
          "This policy describes what we collect, why, where it lives, and how to remove it. We do not sell personal data. We do not show ads.",
        ),
      ],
    },
    {
      id: "what-we-collect",
      title: copy("What we collect"),
      body: [
        copy(
          "Account data - email, hashed password (or OAuth identity), team name, and your role.",
        ),
        copy(
          "Billing data - for Cloud and Business plans only. Card and tax details are processed by Stripe; we store the last four digits and the invoice history.",
        ),
        copy(
          "Project metadata - repository URL, branch, build commands, environment variable names (not values), domain names, deployment timestamps.",
        ),
        copy(
          "Build artifacts - container images we built on your behalf. Stored for the lifetime of the deployment and pruned by our retention policy.",
        ),
        copy(
          "Logs - application and build logs, retained 30 days on Cloud, 12 months on Business.",
        ),
        copy(
          "Telemetry - off by default. If you opt in we collect anonymous platform-version and feature-usage events to inform the roadmap.",
        ),
      ],
    },
    {
      id: "what-we-dont",
      title: copy("What we don't collect"),
      body: [
        copy(
          "Source code outside of build time - we fetch your repo, build, and discard the working tree. The image is what persists.",
        ),
        copy(
          "Decrypted secrets - environment variables are encrypted at rest with keys we never log.",
        ),
        copy(
          "Customer data flowing through your apps. Your databases and your application logs are your data; we host them but we don't read them.",
        ),
        "Behavioural analytics on your end users.",
      ],
    },
    {
      id: "support-access",
      title: copy("Customer-approved support reviews"),
      body: [
        copy(
          "OpenShip staff do not browse your private source code, database contents, application files, or secret values as part of support. Your content remains yours.",
        ),
        copy(
          "Our support team reviews relevant technical metadata and sanitized failure diagnostics only when you request troubleshooting help or approve a review. This can include deployment status, resource usage, infrastructure settings, and the cause of a failed deployment. A review is limited to the technical issue you ask us to investigate.",
        ),
        copy(
          "Routine automated processing needed to build, host, and operate your applications is separate from a human support review. We may also process data where required by applicable law. Our privacy commitments apply alongside your statutory data protection rights.",
        ),
      ],
    },
    {
      id: "where-it-lives",
      title: copy("Where data lives"),
      body: [
        copy(
          "Cloud customers - primary storage in EU-West (Ireland) with replicas in US-East and AP-South. You can pin a project to a single region.",
        ),
        copy(
          "Self-hosted customers - everything stays on the machines you run. We have zero visibility.",
        ),
        copy(
          "Backups - encrypted, region-pinned, 30-day rolling window on Cloud, extended retention on Business.",
        ),
      ],
    },
    {
      id: "third-parties",
      title: copy("Third-party processors"),
      body: [
        "Stripe - payment processing and invoicing.",
        copy("AWS, Hetzner, Cloudflare - infrastructure providers for compute, network, and edge."),
        copy("Postmark - outbound transactional email (account events, billing receipts)."),
        copy("Sentry - error reporting, with PII scrubbing enabled."),
        copy("We do not use marketing trackers, advertising pixels, or session replay tools."),
      ],
    },
    {
      id: "rights",
      title: copy("Your rights"),
      body: [
        copy(
          "Access - request an export of everything we have about you, in machine-readable form.",
        ),
        copy(
          "Deletion - delete your account at any time; we erase identifying data within 30 days and retain only what's required by tax law.",
        ),
        copy(
          "Portability - every deployment is a plain container image and a standard manifest. You can leave Cloud and re-run on your own servers without rewriting anything.",
        ),
        copy(
          "Contact privacy@openship.io for any of the above. We respond within 5 business days.",
        ),
      ],
    },
    {
      id: "changes",
      title: copy("Changes"),
      body: [
        copy(
          "When this policy materially changes we email account owners at least 14 days before the change takes effect, with a side-by-side diff of what's changing and why.",
        ),
      ],
    },
  ];
}

export default function PrivacyPage() {
  const copy = useCopy();
  const SECTIONS = getSections(copy);

  return (
    <>
      <Navbar />
      <main className="legal-root">
        <section className="legal-hero">
          <div className="legal-container">
            <p className="legal-eyebrow">{copy("Privacy")}</p>
            <h1 className="legal-title">
              {copy("How we")}
              <br />
              <span className="legal-title-soft">{copy("handle your data.")}</span>
            </h1>
            <p className="legal-meta">
              {copy("Last updated ")}
              <time dateTime="2026-11-10">{copy("November 10, 2026")}</time>
              <span className="legal-meta-sep">·</span>
              <a
                href="https://github.com/oblien/openship/commits/main/apps/web/src/app/(site)/(marketing)/privacy/page.tsx"
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
              {/* Table of contents */}
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

              {/* Article */}
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
                    {copy("Questions or requests? Email")}{" "}
                    <a href="mailto:privacy@openship.io">{copy("privacy@openship.io")}</a>.
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
