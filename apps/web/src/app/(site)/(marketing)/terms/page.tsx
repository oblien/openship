import type { Metadata, ResolvingMetadata } from "next";
import { SUPPORT_EMAIL } from "@repo/core";
import { inheritSocialImages } from "@/lib/social-metadata";
import { Navbar, Footer } from "@/components/landing";
import { CLOUD_SLA } from "@/lib/cloud-service";

const PAGE_TITLE = "Terms of Service";
const PAGE_DESCRIPTION =
  "Terms governing Openship Cloud and Openship Business. The self-hosted platform itself is governed by the Apache 2.0 license. Plain language, no surprises.";

const metadata: Metadata = {
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

export async function generateMetadata(
  _props: unknown,
  parent: ResolvingMetadata,
): Promise<Metadata> {
  return inheritSocialImages(metadata, parent);
}

const SECTIONS = [
  {
    id: "agreement",
    title: "Agreement",
    body: [
      "These terms govern your use of Openship Cloud (the hosted service) and Openship Business (managed Cloud and connected servers). The self-hosted platform itself is governed by the Apache 2.0 license that ships with the source.",
      "By creating an account you agree to these terms. If you're using Openship on behalf of an organisation, you confirm you have authority to bind that organisation.",
    ],
  },
  {
    id: "the-service",
    title: "The service",
    body: [
      "We provide infrastructure to build, ship, and run your applications - managed databases, mail, storage, routing, and the platform tooling around it.",
      "Openship Cloud resource pool plans cover purchased CPU, RAM and storage for the paid period. Separately priced services and retained storage after that period follow the terms shown in Billing. Existing metered subscriptions keep their saved terms. Self-hosted use is free under the Apache 2.0 license.",
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
      "Openship Cloud plan prices are published on our pricing page. Paid plans are billed monthly in advance and you may cancel at any time; cancellation takes effect at the end of the period you have already paid for. Self-hosted use is free.",
      "We accept major cards via Stripe. Price changes to a plan you are on are announced at least 30 days in advance and apply from your next billing period. A failed payment triggers retries and email notice before any suspension.",
    ],
  },
  {
    id: "uptime-sla",
    title: "Uptime and SLA",
    body: [
      `Openship Cloud guarantees ${CLOUD_SLA.monthlyUptimePercent}% monthly uptime for each paid Cloud Space, on every Cloud plan, whether billed monthly or annually. No enterprise plan or SLA add-on is required. The guarantee covers Openship-managed infrastructure, including infrastructure providers we choose to operate the service. It does not cover servers you host or connect yourself, free trials, or features expressly identified as preview or beta.`,
      "Downtime is a period when a failure of Openship-managed compute, storage, networking, routing, or control-plane services prevents your Cloud Space from running or serving otherwise working workloads, or prevents deployment and lifecycle operations such as starting or restarting workloads. A cosmetic dashboard issue alone is not downtime when those operations and workloads remain available.",
      "We calculate uptime separately for each Cloud Space and each UTC calendar month: uptime percentage = 100 × (eligible minutes − downtime minutes) ÷ eligible minutes. Eligible minutes are the minutes your paid subscription and this SLA were both in effect during that month, excluding the periods described below. Excluded periods are removed from both the eligible time and downtime calculations. Overlapping incidents count once. We use the unrounded percentage to select a credit tier; a month with no eligible minutes has no SLA credit.",
      "We verify the start and end of an outage using infrastructure monitoring, incident records, and reasonable evidence you provide. An outage is measured from its verified start until service is restored, not from when you first contact support. An isolated failed request is evidence to investigate, rather than proof that an entire period was unavailable.",
      `Scheduled maintenance is excluded only when we announce the affected service and maintenance window at least ${CLOUD_SLA.maintenanceNoticeDays} days in advance by email or an in-app notice. Only downtime within that announced window is excluded. Emergency or unannounced maintenance, and downtime beyond the announced window, count unless another exclusion below applies.`,
      "Other exclusions are periods caused by your application code or configuration, exceeding your purchased resource limits, intentional customer stops or customer-caused deployment interruptions, external dependencies you choose such as a repository, registry or DNS provider, or an internet connection outside our managed network. A suspension permitted by these terms, including for overdue payment or abuse, is excluded. A failure in our own billing or suspension systems is not excluded on that basis. Failure of an infrastructure provider we use is not, by itself, an exclusion. If both covered and excluded causes occur, we count any period in which a covered failure independently makes the service unavailable.",
    ],
  },
  {
    id: "sla-credits",
    title: "Service credits",
    body: [
      `If a Cloud Space’s verified monthly uptime is below ${CLOUD_SLA.monthlyUptimePercent}%, you can claim a service credit at the following rates:`,
      ...CLOUD_SLA.creditTiers.map((tier, index) => {
        const upper =
          index === 0
            ? CLOUD_SLA.monthlyUptimePercent
            : CLOUD_SLA.creditTiers[index - 1].minimumUptimePercent;
        return tier.minimumUptimePercent === 0
          ? `Below ${upper}% uptime: a ${tier.creditPercent}% service credit.`
          : `${tier.minimumUptimePercent}% to less than ${upper}% uptime: a ${tier.creditPercent}% service credit.`;
      }),
      "The percentage applies to the subscription fees attributable to the affected Cloud Space for that calendar month, after discounts and excluding taxes, usage add-ons and separately billed services. For an annual subscription, the monthly fee is one twelfth of the annual subscription fee. Partial months and plan changes are prorated to the applicable paid period and rate.",
      "Only the highest applicable tier is awarded for each Cloud Space and month. Multiple incidents or claims do not stack, and the total SLA credit cannot exceed 100% of that Cloud Space’s applicable monthly subscription fee. Unaffected Cloud Spaces are calculated separately.",
      `Approved credits are added to your account within ${CLOUD_SLA.creditIssueDays} days after approval and offset your next eligible Openship Cloud subscription invoice, including an annual renewal. Credits are not a cash refund and cannot be transferred to another account. These credits are the remedy provided by this SLA; they do not limit rights that cannot be excluded by applicable law. A separate written SLA takes precedence only where its terms expressly differ.`,
    ],
  },
  {
    id: "sla-claims",
    title: "Support and SLA claims",
    body: [
      <>
        Support is included with every Cloud plan. Report an incident or submit an SLA claim to{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`} className="underline underline-offset-4">
          {SUPPORT_EMAIL}
        </a>
        , through Support in your app’s sidebar, or through our{" "}
        <a href="/support" className="underline underline-offset-4">
          public support page
        </a>{" "}
        if you cannot sign in. Support response and resolution times are not guaranteed unless a
        separate written agreement specifies them.
      </>,
      `Submit a credit claim within ${CLOUD_SLA.claimWindowDays} days after the end of the affected UTC calendar month. Include your account email, affected Cloud Space ID, outage dates and times with a timezone, and a brief description of what failed. Logs or screenshots help where available; remove passwords, tokens and other sensitive information before sending them. You do not need to open a separate ticket for every interruption in the same claim.`,
      `We review our monitoring and incident records alongside your evidence and may ask for information needed to verify the claim. We will send a decision, the uptime calculation and any approved credit amount within ${CLOUD_SLA.claimReviewBusinessDays} business days after receiving the information needed to assess the claim. Credits are reviewed and issued through support; they are not applied automatically when an outage occurs.`,
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
      "Except for the express commitments in the Cloud SLA above or a separate written agreement, the service is provided “as is”. We disclaim implied warranties of merchantability and fitness for a particular purpose to the maximum extent permitted by law.",
      "The Cloud SLA remains applicable, but it is not a promise of uninterrupted or error-free service, or that the service will meet every specific requirement.",
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
              The rules
              <br />
              <span className="legal-title-soft">in plain words.</span>
            </h1>
            <p className="legal-meta">
              Last updated <time dateTime="2026-11-10">November&nbsp;10, 2026</time>
              <span className="legal-meta-sep">·</span>
              <a
                href="https://github.com/oblien/openship/commits/main/apps/web/src/app/(site)/(marketing)/terms/page.tsx"
                className="legal-meta-link"
                target="_blank"
                rel="noreferrer"
              >
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
                      <p key={j} className="legal-p">
                        {p}
                      </p>
                    ))}
                  </section>
                ))}

                <footer className="legal-foot">
                  <p>
                    Questions? Email <a href="mailto:legal@openship.io">legal@openship.io</a>.
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
