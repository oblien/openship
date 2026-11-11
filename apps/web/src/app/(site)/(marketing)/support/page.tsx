import type { Metadata } from "next";
import Link from "next/link";
import { BRAND_LINKS, CLOUD_DASHBOARD_URL } from "@repo/core";
import { Navbar, Footer } from "@/components/landing";
import { MarketingIntro } from "@/components/marketing/marketing-intro";

export const metadata: Metadata = {
  title: "Customer Support",
  description: "Sign in to Openship to get help with your deployments, account, or billing.",
  alternates: { canonical: "/support" },
};

export default function SupportPage() {
  return (
    <>
      <Navbar />
      <main className="marketing-page">
        <MarketingIntro
          eyebrow="Customer support"
          title={
            <>
              We’re here
              <br />
              <span>to help.</span>
            </>
          }
          description="Get help with your deployments, account, or billing from your Openship dashboard. Sign in to open a request, follow its progress, and continue the conversation."
        />
        <div className="site-container marketing-content">
          <div className="marketing-contact-notes">
            <a
              className="th-btn inline-flex rounded-full px-6 py-3 text-sm"
              href={`${CLOUD_DASHBOARD_URL}/support`}
            >
              Sign in for support
            </a>
            <p>
              Already have a request? You can continue in the dashboard or reply to the team’s
              email.
            </p>
            <p>
              Can’t access your account? <Link href="/contact">Contact the team</Link> for help
              signing in.
            </p>
            <p>
              <a href={BRAND_LINKS.docs}>Read the documentation</a> or{" "}
              <a href={BRAND_LINKS.community}>ask the community</a>.
            </p>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
