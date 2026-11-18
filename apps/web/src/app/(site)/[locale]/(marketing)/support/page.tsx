import { useCopy } from "@/i18n/use-copy";
import { localizedMetadata } from "@/i18n/metadata";

import type { Metadata, ResolvingMetadata } from "next";
import { inheritSocialImages } from "@/lib/social-metadata";
import { Link } from "@/i18n/Link";
import { BRAND_LINKS, CLOUD_DASHBOARD_URL } from "@repo/core";
import { Navbar, Footer } from "@/components/landing";
import { MarketingIntro } from "@/components/marketing/marketing-intro";

const pageMetadata = {
  title: "Customer Support",
  description: "Sign in to OpenShip to get help with your deployments, account, or billing.",
  alternates: { canonical: "/support" },
} satisfies Metadata;

export default function SupportPage() {
  const copy = useCopy();

  return (
    <>
      <Navbar />
      <main className="marketing-page">
        <MarketingIntro
          eyebrow="Customer support"
          title={
            <>
              {copy("We’re here")}
              <br />
              <span>{copy("to help.")}</span>
            </>
          }
          description={copy(
            "Get help with your deployments, account, or billing from your OpenShip dashboard. Sign in to open a request, follow its progress, and continue the conversation.",
          )}
        />
        <div className="site-container marketing-content">
          <div className="marketing-contact-notes">
            <a
              className="th-btn inline-flex rounded-full px-6 py-3 text-sm"
              href={`${CLOUD_DASHBOARD_URL}/support`}
            >
              {copy("Sign in for support")}
            </a>
            <p>
              {copy(
                "Already have a request? You can continue in the dashboard or reply to the team’s email.",
              )}
            </p>
            <p>
              {copy("Can’t access your account? ")}
              <Link href="/contact">{copy("Contact the team")}</Link>{" "}
              {copy(" for help signing in.")}
            </p>
            <p>
              <a href={BRAND_LINKS.docs}>{copy("Read the documentation")}</a>
              {copy(" or ")}
              <a href={BRAND_LINKS.community}>{copy("ask the community")}</a>.
            </p>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}

export async function generateMetadata(_: unknown, parent: ResolvingMetadata) {
  const { title, description } = pageMetadata;
  return localizedMetadata(
    await inheritSocialImages(
      {
        ...pageMetadata,
        openGraph: { title, description, type: "website", siteName: "OpenShip" },
        twitter: { card: "summary_large_image", title, description },
      },
      parent,
    ),
  );
}
