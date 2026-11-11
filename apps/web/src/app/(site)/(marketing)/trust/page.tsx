import type { Metadata } from "next";
import { Navbar, Footer } from "@/components/landing";
import { MarketingIntro } from "@/components/marketing/marketing-intro";
import { MarketingSection } from "@/components/marketing/marketing-section";
import {
  IllustratedLink,
  type IllustratedLinkProps,
} from "@/components/marketing/illustrated-link";

export const metadata: Metadata = {
  title: "Trust & Security – Openship",
  description:
    "How Openship handles your data, permissions, and the boundary between self-hosted instances and Openship Cloud.",
  alternates: { canonical: "/trust" },
};

const PILLARS: IllustratedLinkProps[] = [
  {
    title: "Data ownership",
    description:
      "Local projects belong to your instance. Cloud projects belong to Cloud. See where your records and settings live.",
    illustration: "persistent-storage",
    href: "/docs/architecture/data-ownership",
  },
  {
    title: "Access and permissions",
    description:
      "Roles and resource grants determine who can view and manage each project, server, and workspace.",
    illustration: "resource-permissions",
    href: "/docs/security/permissions",
  },
  {
    title: "The Cloud boundary",
    description:
      "Understand how a self-hosted instance connects to Cloud and which identity authorizes a request.",
    illustration: "private-networking",
    href: "/docs/security/cloud-boundary",
  },
  {
    title: "Credentials and sessions",
    description:
      "Review how authentication, connected accounts, and credentials are handled by the platform.",
    illustration: "secrets-credentials",
    href: "/docs/security/auth",
  },
  {
    title: "Your hosting choice",
    description:
      "Run Openship on your own infrastructure or use Cloud. Choose the operating model that meets your requirements.",
    illustration: "server-management",
    href: "/docs/architecture/overview",
  },
  {
    title: "Open for review",
    description:
      "Inspect the platform’s code, permissions, and Cloud gateway. Openship is open source under Apache 2.0.",
    illustration: "configuration-as-code",
    href: "https://github.com/oblien/openship",
  },
];

export default function TrustPage() {
  return (
    <>
      <Navbar />
      <main className="marketing-page">
        <MarketingIntro
          eyebrow="Trust & security"
          title={
            <>
              Your data.
              <br />
              <span>Clear boundaries.</span>
            </>
          }
          description="Know where your data lives, who can access it, and how your installation connects to Cloud. The architecture and code are open to review."
        />
        <div className="site-container marketing-content">
          <MarketingSection
            id="security"
            title="How it works"
            description="Explore the platform’s security model and the details behind it."
          >
            <div className="marketing-grid">
              {PILLARS.map((pillar) => (
                <IllustratedLink key={pillar.title} {...pillar} />
              ))}
            </div>
          </MarketingSection>
          <MarketingSection
            id="disclosure"
            title="Report a vulnerability"
            description="Send sensitive security findings directly to the team."
          >
            <div className="marketing-prose">
              <p>
                Please report suspected vulnerabilities privately to{" "}
                <a href="mailto:security@oblien.com">security@oblien.com</a>. Include the affected
                version, steps to reproduce, and the impact you observed. Keep credentials and
                customer data out of your report.
              </p>
              <p>
                Evaluating Openship for your organization? <a href="/contact">Contact us</a> with
                your security or compliance requirements. Review the linked documentation for
                implementation details.
              </p>
            </div>
          </MarketingSection>
        </div>
      </main>
      <Footer />
    </>
  );
}
