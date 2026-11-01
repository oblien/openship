import type { Metadata, ResolvingMetadata } from "next";
import { inheritSocialImages } from "@/lib/social-metadata";
import { Navbar, Footer } from "@/components/landing";

const PAGE_TITLE = "About";
const PAGE_DESCRIPTION =
  "Openship is an open-source deployment platform built and maintained by the team at Oblien. Apache 2.0, source on GitHub, yours to run anywhere.";

const metadata: Metadata = {
  title: PAGE_TITLE,
  description: PAGE_DESCRIPTION,
  alternates: { canonical: "/about" },
  openGraph: {
    title: `${PAGE_TITLE} - Openship`,
    description: PAGE_DESCRIPTION,
    url: "/about",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: `${PAGE_TITLE} - Openship`,
    description: PAGE_DESCRIPTION,
  },
};

export async function generateMetadata(
  _props: unknown,
  parent: ResolvingMetadata,
): Promise<Metadata> {
  return inheritSocialImages(metadata, parent);
}

const TOC = [
  { id: "what", title: "What we build" },
  { id: "open-source", title: "Open source" },
  { id: "who", title: "Who's behind it" },
  { id: "involved", title: "Get involved" },
];

export default function AboutPage() {
  return (
    <>
      <Navbar />
      <main className="legal-root">
        <section className="legal-hero">
          <div className="legal-container">
            <p className="legal-eyebrow">About</p>
            <h1 className="legal-title">
              Deployment you own,<br />
              <span className="legal-title-soft">open from top to bottom.</span>
            </h1>
            <p className="legal-meta">
              Built and maintained by the team at{" "}
              <a href="https://oblien.com" className="legal-meta-link" target="_blank" rel="noreferrer">
                Oblien
              </a>
              .
            </p>
          </div>
        </section>

        <section className="legal-body">
          <div className="legal-container">
            <div className="legal-grid">
              <aside className="legal-toc" aria-label="Table of contents">
                <p className="legal-toc-title">On this page</p>
                <ol>
                  {TOC.map((t, i) => (
                    <li key={t.id}>
                      <a href={`#${t.id}`}>
                        <span className="legal-toc-n">{String(i + 1).padStart(2, "0")}</span>
                        {t.title}
                      </a>
                    </li>
                  ))}
                </ol>
              </aside>

              <article className="legal-article">
                <section id="what" className="legal-section">
                  <header className="legal-section-head">
                    <span className="legal-section-n">01</span>
                    <h2 className="legal-section-title">What we build</h2>
                  </header>
                  <p className="legal-p">
                    Openship is a deployment platform you run yourself. Point it at a repository and it
                    detects your stack, builds it, and ships it to any Linux server you own — with databases,
                    domains, SSL, mail, and backups managed from one place.
                  </p>
                  <p className="legal-p">
                    The same platform comes as a CLI, a web dashboard, and a desktop app. Use whichever fits
                    how you work; they all drive the same backend.
                  </p>
                </section>

                <section id="open-source" className="legal-section">
                  <header className="legal-section-head">
                    <span className="legal-section-n">02</span>
                    <h2 className="legal-section-title">Open source</h2>
                  </header>
                  <p className="legal-p">
                    Openship is open-source software under the{" "}
                    <a href="https://github.com/oblien/openship/blob/main/LICENSE" target="_blank" rel="noreferrer">
                      Apache License 2.0
                    </a>
                    . The dashboard, CLI, agents, and infrastructure adapters are all public and auditable on{" "}
                    <a href="https://github.com/oblien/openship" target="_blank" rel="noreferrer">GitHub</a>.
                  </p>
                  <p className="legal-p">
                    Every deployment is a standard Docker container with standard manifests — no proprietary
                    formats, no lock-in. Run it on a Raspberry Pi, a single VPS, or a fleet, and move between
                    providers whenever you like.
                  </p>
                </section>

                <section id="who" className="legal-section">
                  <header className="legal-section-head">
                    <span className="legal-section-n">03</span>
                    <h2 className="legal-section-title">Who&rsquo;s behind it</h2>
                  </header>
                  <p className="legal-p">
                    Openship is built and maintained by the team at{" "}
                    <a href="https://oblien.com" target="_blank" rel="noreferrer">Oblien</a> (Oblien LLC), which
                    builds cloud and developer infrastructure. It stays open under Apache 2.0 for everyone who
                    deploys with it.
                  </p>
                  <p className="legal-p">
                    Openship Cloud — the managed option — is operated by Oblien, but the platform itself is
                    yours to self-host, forever, at no cost.
                  </p>
                </section>

                <section id="involved" className="legal-section">
                  <header className="legal-section-head">
                    <span className="legal-section-n">04</span>
                    <h2 className="legal-section-title">Get involved</h2>
                  </header>
                  <p className="legal-p">
                    Star or fork the project, open an issue, or send a pull request on{" "}
                    <a href="https://github.com/oblien/openship" target="_blank" rel="noreferrer">GitHub</a>.
                    Bug reports and feature ideas are genuinely welcome — the docs and the platform improve
                    fastest with them.
                  </p>
                  <p className="legal-p">
                    New here? Start with the <a href="/docs">documentation</a> or{" "}
                    <a href="/download">install in one command</a>.
                  </p>
                </section>

                <footer className="legal-foot">
                  <p>
                    Want to reach us? Head to <a href="/contact">Contact</a>.
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
