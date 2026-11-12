import { Link } from "@/i18n/Link";
import { useCopy } from "@/i18n/use-copy";
import { localizedMetadata } from "@/i18n/metadata";

import type { Metadata } from "next";
import { Navbar, Footer } from "@/components/landing";
import { MarketingIntro } from "@/components/marketing/marketing-intro";
import { MarketingSection } from "@/components/marketing/marketing-section";
import {
  IllustratedLink,
  type IllustratedLinkProps,
} from "@/components/marketing/illustrated-link";

const pageMetadata: Metadata = {
  title: "Trust & Security – OpenShip",
  description:
    "How OpenShip handles your data, permissions, and the boundary between self-hosted instances and OpenShip Cloud.",
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
      "Run OpenShip on your own infrastructure or use Cloud. Choose the operating model that meets your requirements.",
    illustration: "server-management",
    href: "/docs/architecture/overview",
  },
  {
    title: "Open for review",
    description:
      "Inspect the platform’s code, permissions, and Cloud gateway. OpenShip is open source under Apache 2.0.",
    illustration: "configuration-as-code",
    href: "https://github.com/oblien/openship",
  },
];

export default function TrustPage() {
  const copy = useCopy();

  return (
    <>
      <Navbar />
      <main className="marketing-page">
        <MarketingIntro
          eyebrow="Trust & security"
          title={
            <>
              {copy("Your data.")}
              <br />
              <span>{copy("Clear boundaries.")}</span>
            </>
          }
          description={copy(
            "Know where your data lives, who can access it, and how your installation connects to Cloud. The architecture and code are open to review.",
          )}
        />
        <div className="site-container marketing-content">
          <MarketingSection
            id="security"
            title={copy("How it works")}
            description={copy("Explore the platform’s security model and the details behind it.")}
          >
            <div className="marketing-grid">
              {PILLARS.map((pillar) => (
                <IllustratedLink key={pillar.title} {...pillar} />
              ))}
            </div>
          </MarketingSection>
          <MarketingSection
            id="disclosure"
            title={copy("Report a vulnerability")}
            description={copy("Send sensitive security findings directly to the team.")}
          >
            <div className="marketing-prose">
              <p>
                {copy("Please report suspected vulnerabilities privately to")}{" "}
                <a href="mailto:security@oblien.com">security@oblien.com</a>
                {copy(
                  ". Include the affected version, steps to reproduce, and the impact you observed. Keep credentials and customer data out of your report.",
                )}
              </p>
              <p>
                {copy("Evaluating OpenShip for your organization? ")}
                <Link href="/contact">{copy("Contact us")}</Link>{" "}
                {copy(
                  " with your security or compliance requirements. Review the linked documentation for implementation details.",
                )}
              </p>
            </div>
          </MarketingSection>
        </div>
      </main>
      <Footer />
    </>
  );
}

export async function generateMetadata() {
  return localizedMetadata(pageMetadata);
}
