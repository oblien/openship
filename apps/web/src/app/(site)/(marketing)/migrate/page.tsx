import Link from "next/link";
import { ArrowRight, Plus } from "lucide-react";
import { FeatureIllustration } from "@repo/ui/illustrations";
import { Navbar, Footer } from "@/components/landing";
import { MarketingIntro } from "@/components/marketing/marketing-intro";
import { MarketingSection } from "@/components/marketing/marketing-section";
import { IllustratedLink } from "@/components/marketing/illustrated-link";
import { cloudFrom, getCloudPricing } from "@/lib/pricing";
import { cloudPlanHref } from "@/lib/cloud-links";
import { STARTING_POINTS, REASONS, STEPS, faq } from "./_data";
import "./migrate.css";

export const revalidate = 60;

export default async function MigratePage() {
  const from = cloudFrom(await getCloudPricing());
  return (
    <>
      <Navbar />
      <main className="marketing-page">
        <MarketingIntro
          eyebrow="Move to Openship"
          title={
            <>
              Bring your app.
              <br />
              <span>Keep your stack.</span>
            </>
          }
          description="Bring your repository, Compose stack, or running Docker services. Move to Openship Cloud or manage your own infrastructure."
        >
          <Link href="/support" className="marketing-text-link mg-intro-link">
            Talk through your migration <ArrowRight size={16} aria-hidden="true" />
          </Link>
        </MarketingIntro>
        <div className="site-container marketing-content">
          <MarketingSection
            id="start"
            title="Start with what you have"
            description="Choose the guide that matches how your app runs today."
          >
            <div className="marketing-grid">
              {STARTING_POINTS.map((item) => (
                <IllustratedLink key={item.title} {...item} />
              ))}
            </div>
          </MarketingSection>
          <MarketingSection
            id="steps"
            title="Plan the move"
            description="Prepare the destination, verify the app, then switch traffic."
          >
            <ol className="mg-steps">
              {STEPS.map((step, index) => (
                <li key={step.title}>
                  <span className="mg-step-number" aria-hidden="true">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <div>
                    <h3>{step.title}</h3>
                    <p>{step.description}</p>
                  </div>
                </li>
              ))}
            </ol>
          </MarketingSection>
          <MarketingSection
            id="destination"
            title="Choose where it runs"
            description="The same deployment tools, with a hosting model that fits your team."
          >
            <div className="mg-destinations">
              <div className="mg-destination">
                <FeatureIllustration name="deploy-anywhere" className="marketing-illustration" />
                <h3>Openship Cloud</h3>
                <p>
                  A managed resource pool for your projects. Apps, builds, and data share your
                  plan’s capacity.
                </p>
                <span className="mg-price">
                  {from ? `From ${from}/month` : "Explore Cloud plans"}
                </span>
                <a href={cloudPlanHref()} className="th-btn mg-destination-action">
                  Start on Cloud <ArrowRight size={16} aria-hidden="true" />
                </a>
              </div>
              <div className="mg-destination">
                <FeatureIllustration name="server-management" className="marketing-illustration" />
                <h3>Your infrastructure</h3>
                <p>Connect your servers and manage deployments, data, and domains from Openship.</p>
                <span className="mg-price">Free to self-host</span>
                <Link
                  href="/docs/getting-started/installation"
                  className="marketing-text-link mg-destination-action"
                >
                  Set up Openship <ArrowRight size={16} aria-hidden="true" />
                </Link>
              </div>
            </div>
          </MarketingSection>
          <MarketingSection
            id="situations"
            title="What changes"
            description="More of your stack in one place, with control over where it lives."
          >
            <div className="marketing-grid">
              {REASONS.map((item) => (
                <IllustratedLink key={item.id} {...item} />
              ))}
            </div>
          </MarketingSection>
          <MarketingSection
            id="faq"
            title="Before you move"
            description="The practical details, from compatibility to cutover."
          >
            <div className="mg-faq">
              {faq(from).map((item) => (
                <details key={item.q}>
                  <summary>
                    {item.q}
                    <Plus size={16} aria-hidden="true" />
                  </summary>
                  <p>{item.a}</p>
                </details>
              ))}
            </div>
          </MarketingSection>
        </div>
      </main>
      <Footer />
    </>
  );
}
