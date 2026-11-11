import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { FeatureIllustration, type FeatureIllustrationName } from "@repo/ui/illustrations";

const COMMITMENTS = [
  {
    illustration: "resource-permissions",
    title: "Support starts with your approval.",
    description:
      "Our team reviews technical details only when you ask for help or approve a review.",
  },
  {
    illustration: "secrets-credentials",
    title: "Technical details only.",
    description:
      "Relevant deployment metadata and sanitized failure diagnostics. Your code, database contents, files, and secret values stay out of support review.",
  },
  {
    illustration: "audit-log",
    title: "A commitment in writing.",
    description:
      "Our Privacy Policy and Terms set out how we handle your data, alongside your rights under applicable data protection law.",
  },
] satisfies {
  illustration: FeatureIllustrationName;
  title: string;
  description: string;
}[];

export function DataPrivacy() {
  return (
    <section id="data-privacy" className="privacy-section" aria-labelledby="privacy-title">
      <div className="site-container privacy-layout">
        <div className="privacy-intro">
          <p className="privacy-eyebrow">Our privacy commitment</p>
          <h2 id="privacy-title" className="privacy-title">
            Your data.
            <br />
            <span>Your business.</span>
          </h2>
          <p className="privacy-description">
            We don’t browse your private code, databases, or files. When you need help, support
            stays focused on the technical issue you ask us to investigate.
          </p>
          <div className="privacy-links">
            <Link href="/privacy#support-access">
              Read our privacy policy <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
            <Link href="/terms#your-content">
              Terms of service <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </div>
        </div>
        <ul className="privacy-commitments" aria-label="Customer privacy commitments">
          {COMMITMENTS.map((commitment) => (
            <li key={commitment.title} className="privacy-commitment">
              <FeatureIllustration name={commitment.illustration} className="privacy-art" />
              <div>
                <h3>{commitment.title}</h3>
                <p>{commitment.description}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
