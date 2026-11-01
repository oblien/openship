import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  BarChart3,
  Check,
  ChevronDown,
  Cloud,
  Link2,
  Repeat2,
  Wallet,
} from "lucide-react";
import { Navbar } from "@/components/landing/navbar";
import { Footer } from "@/components/landing/footer";
import { AFFILIATE_PROGRAM as program } from "@/lib/affiliate-program";
import { CommissionPreview } from "./commission-preview";
import styles from "./affiliates.module.css";

const title = "OpenShip Affiliates — Good tools are worth sharing.";
const description =
  "Introduce someone to OpenShip. Share a useful tool, offer an optional discount, " +
  `and receive up to ${program.commissionPercent}% commission on eligible Cloud payments for ${program.rewardMonths} months.`;
const socialImage = {
  url: "/og/affiliates.png",
  width: 1200,
  height: 630,
  alt: "OpenShip Affiliates. Good tools are worth sharing.",
};

export const metadata: Metadata = {
  title: "Affiliates",
  description,
  alternates: { canonical: "/affiliates" },
  openGraph: {
    title,
    description,
    url: "/affiliates",
    siteName: "OpenShip",
    type: "website",
    images: [socialImage],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    site: "@openshipio",
    creator: "@openshipio",
    images: [socialImage],
  },
};

const steps = [
  {
    icon: Link2,
    title: "Start with a link",
    copy: "Join from your Cloud account. Choose the eligible plans you want to recommend, and add a customer discount if you like.",
  },
  {
    icon: Repeat2,
    title: "Make an introduction",
    copy: "A guide, a project, a conversation. Share OpenShip where it helps. People can see their eligible plans and discount before checking out.",
  },
  {
    icon: BarChart3,
    title: "Keep track, simply",
    copy: "See referrals, verified payments and your available commission in one dashboard. Request a payout when you reach your minimum.",
  },
];

const questions = [
  {
    question: "How do I join?",
    answer:
      "Sign in or create an OpenShip Cloud account, visit the affiliate dashboard and choose Join the program. Review your program terms, then create your first referral link. You can share a link or its referral code.",
  },
  {
    question: "Which purchases qualify?",
    answer: `Qualifying monthly and annual Cloud VM compute plans, starting at $${program.minimumMonthlyPlanUsd} per month equivalent ($${program.minimumMonthlyPlanUsd * 12} per year before discounts). Manage plans, prepaid PAYG, credit top-ups, free plans and plan-change prorations are excluded. You cannot refer yourself or a workspace you belong to.`,
  },
  {
    question: "Does an annual plan earn commission?",
    answer: `Yes. Commission is calculated on the eligible full annual payment and credited after that payment is verified; you do not wait until the year ends. With the current ${program.rewardMonths}-month reward period, the first annual payment qualifies, while the renewal a year later falls outside the window.`,
  },
  {
    question: "When does the reward period start?",
    answer: `Each referred customer's ${program.rewardMonths}-month period begins with their first eligible payment. Confirmed renewals within that period also qualify. Creating a link earlier, renewing or changing plans does not restart the period.`,
  },
  {
    question: "How do discounts affect my commission?",
    answer: `The customer discount comes from the ${program.commissionPercent}% commission budget. For example, a 5% discount leaves you 15% of the eligible pretax subtotal. With no discount, you keep the full ${program.commissionPercent}%. Earnings are based on verified eligible payments and can be adjusted for refunds.`,
  },
  {
    question: "How and when do I receive a payout?",
    answer: `Save a payout destination, then request a payout once your available earnings reach your minimum. The default is $${program.minimumPayoutUsd}; your dashboard shows any individually approved terms. OpenShip manually reviews and pays requests. PayPal, bank transfer, Wise and Payoneer are supported destinations, subject to country and provider availability. Earnings are not an automatic cash transfer.`,
  },
  {
    question: "Can I change or revoke a referral link?",
    answer:
      "You can revoke a link to stop new referrals. Create a new link if you want different terms or plan selections. Revoking a link does not change accepted checkouts or the terms of customers already referred through it.",
  },
];

export default function AffiliatesPage() {
  return (
    <>
      <Navbar />
      <main className={styles.root}>
        <section className={styles.hero} aria-labelledby="affiliate-title">
          <div className={styles.container}>
            <div className={styles.heroGrid}>
              <div>
                <p className={styles.eyebrow}>OpenShip Affiliates</p>
                <h1 id="affiliate-title" className={styles.heroTitle}>
                  Good tools are
                  <br />
                  <span>worth sharing.</span>
                </h1>
                <p className={styles.heroCopy}>
                  Help someone find a better way to deploy. Our affiliate program is a small
                  thank-you for making the introduction.
                </p>
                <div className={styles.actions}>
                  <a href={program.joinUrl} className={styles.primaryButton}>
                    Join the program <ArrowRight size={17} aria-hidden="true" />
                  </a>
                  <a href="#how-it-works" className={styles.textLink}>
                    How it works <ArrowRight size={16} aria-hidden="true" />
                  </a>
                </div>
                <p className={styles.heroNote}>For developers, educators, and people who build.</p>
              </div>
              <div className={styles.connections} aria-hidden="true">
                <div className={styles.orbit} />
                <div className={styles.orbitInner} />
                <svg className={styles.connectionLines} viewBox="0 0 480 420" fill="none">
                  <path d="M145 105C145 165 240 135 240 210S345 245 345 310" />
                  <circle cx="145" cy="105" r="3" />
                  <circle cx="345" cy="310" r="3" />
                </svg>
                <div className={styles.introduction}>
                  <span className={styles.noteIcon}>
                    <Link2 size={19} />
                  </span>
                  <div>
                    <strong>Your recommendation</strong>
                    <span>A guide. A project. A good word.</span>
                  </div>
                </div>
                <div className={styles.connectionMark}>
                  <span />
                </div>
                <div className={styles.destination}>
                  <span className={styles.noteIcon}>
                    <Cloud size={20} />
                  </span>
                  <div>
                    <strong>Their next deployment</strong>
                    <span>A new home on OpenShip Cloud.</span>
                  </div>
                  <ArrowRight size={16} />
                </div>
                <p className={styles.connectionCaption}>Good things travel by word of mouth.</p>
              </div>
            </div>
            <dl className={styles.facts}>
              <div>
                <dt>Commission</dt>
                <dd>
                  Up to {program.commissionPercent}%<span>on eligible Cloud payments</span>
                </dd>
              </div>
              <div>
                <dt>Referral period</dt>
                <dd>
                  {program.rewardMonths} months<span>from their first eligible payment</span>
                </dd>
              </div>
              <div>
                <dt>Payouts</dt>
                <dd>
                  From ${program.minimumPayoutUsd}
                  <span>requested by you, reviewed by us</span>
                </dd>
              </div>
            </dl>
          </div>
        </section>

        <section
          id="how-it-works"
          className={`${styles.container} ${styles.section}`}
          aria-labelledby="steps-title"
        >
          <div className={styles.sectionHeading}>
            <p className={styles.eyebrow}>How it works</p>
            <h2 id="steps-title">
              A thoughtful introduction.
              <br />A straightforward program.
            </h2>
          </div>
          <ol className={styles.steps}>
            {steps.map(({ icon: Icon, title: stepTitle, copy }, index) => (
              <li key={stepTitle}>
                <div className={styles.stepTop}>
                  <Icon size={24} aria-hidden="true" />
                  <span>0{index + 1}</span>
                </div>
                <h3>{stepTitle}</h3>
                <p>{copy}</p>
              </li>
            ))}
          </ol>
        </section>

        <section
          className={`${styles.container} ${styles.splitSection}`}
          aria-labelledby="split-title"
        >
          <div className={styles.splitIntro}>
            <p className={styles.eyebrow}>A little flexibility</p>
            <h2 id="split-title">Make the link your own.</h2>
            <p>
              Keep the full {program.commissionPercent}% commission, or give your audience a
              discount from that budget. You choose the split when you create a link.
            </p>
            <ul className={styles.checkList}>
              <li>
                <Check size={18} aria-hidden="true" /> Choose individual plans and billing intervals
              </li>
              <li>
                <Check size={18} aria-hidden="true" /> Set an optional expiration for new referrals
              </li>
              <li>
                <Check size={18} aria-hidden="true" /> See estimated earnings before sharing
              </li>
            </ul>
          </div>
          <CommissionPreview />
        </section>

        <section className={`${styles.container} ${styles.section}`} aria-labelledby="timing-title">
          <div className={styles.sectionHeading}>
            <p className={styles.eyebrow}>The details, upfront</p>
            <h2 id="timing-title">Clear from the first payment.</h2>
            <p>
              Earnings start when an eligible payment is verified. Cash payouts are requested
              separately.
            </p>
          </div>
          <div className={styles.timingGrid}>
            <article className={styles.timingCard}>
              <Repeat2 size={26} aria-hidden="true" />
              <h3>Monthly subscriptions</h3>
              <p>
                Earn on the first eligible payment and confirmed renewals within each
                customer&apos;s original {program.rewardMonths}-month reward period.
              </p>
              <div
                className={styles.timeline}
                aria-label="First payment followed by eligible monthly renewals"
              >
                <span>First payment</span>
                <ArrowRight size={18} aria-hidden="true" />
                <span>Eligible renewals</span>
              </div>
            </article>
            <article className={styles.timingCard}>
              <Wallet size={26} aria-hidden="true" />
              <h3>Annual subscriptions</h3>
              <p>
                Earn on the full eligible annual charge after verification. With a{" "}
                {program.rewardMonths}-month reward period, the next annual renewal is outside the
                window.
              </p>
              <div
                className={styles.timeline}
                aria-label="The first full annual payment earns commission"
              >
                <Check size={18} aria-hidden="true" />
                <span>Full first annual payment</span>
              </div>
            </article>
          </div>
        </section>

        <section
          className={`${styles.container} ${styles.payoutSection}`}
          aria-labelledby="payout-title"
        >
          <div>
            <p className={styles.eyebrow}>Payouts</p>
            <h2 id="payout-title">Know where you stand.</h2>
            <p>
              Save your payout account, reach your minimum, then submit a request. We review each
              request and arrange the payment.
            </p>
            <div className={styles.methods} aria-label="Supported manual payout destinations">
              <span>PayPal</span>
              <span>Bank transfer</span>
              <span>Wise</span>
              <span>Payoneer</span>
            </div>
            <p className={styles.methodNote}>
              Availability depends on your country and payment provider.
            </p>
          </div>
          <div className={styles.payoutCard}>
            <Wallet size={27} aria-hidden="true" />
            <p className={styles.payoutAmount}>
              ${program.minimumPayoutUsd}
              <span>default minimum</span>
            </p>
            <p>
              Your dashboard shows your available balance, pending requests and completed payouts,
              along with your account&apos;s current payout minimum.
            </p>
            <Link href={program.guideUrl} className={styles.textLink}>
              Read the payout guide <ArrowRight size={17} aria-hidden="true" />
            </Link>
          </div>
        </section>

        <section className={`${styles.container} ${styles.faqSection}`} aria-labelledby="faq-title">
          <div className={styles.sectionHeading}>
            <p className={styles.eyebrow}>A few useful details</p>
            <h2 id="faq-title">Before you share.</h2>
          </div>
          <div className={styles.faqList}>
            {questions.map(({ question, answer }) => (
              <details key={question}>
                <summary>
                  {question}
                  <ChevronDown size={19} aria-hidden="true" />
                </summary>
                <p>{answer}</p>
              </details>
            ))}
          </div>
          <p className={styles.termsNote}>
            Current program terms are shown in your Cloud account before you join and create a link.
          </p>
        </section>

        <section className={`${styles.container} ${styles.finalCta}`} aria-labelledby="join-title">
          <div>
            <p className={styles.eyebrow}>OpenShip Affiliates</p>
            <h2 id="join-title">Have someone in mind?</h2>
            <p className={styles.finalCopy}>Share OpenShip when it feels like the right fit.</p>
          </div>
          <a href={program.joinUrl} className={styles.primaryButton}>
            Join the program <ArrowRight size={17} aria-hidden="true" />
          </a>
        </section>
      </main>
      <Footer />
    </>
  );
}
