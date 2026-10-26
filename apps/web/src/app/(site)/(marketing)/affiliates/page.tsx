import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  BarChart3,
  Check,
  ChevronDown,
  Gift,
  Link2,
  Repeat2,
  Wallet,
} from "lucide-react";
import { Navbar } from "@/components/landing/navbar";
import { Footer } from "@/components/landing/footer";
import { AFFILIATE_PROGRAM as program } from "@/lib/affiliate-program";
import { CommissionPreview } from "./commission-preview";
import styles from "./affiliates.module.css";

const title = "OpenShip Earn — Share OpenShip. Get rewarded.";
const description =
  `Earn up to ${program.commissionPercent}% on eligible OpenShip Cloud payments for ${program.rewardMonths} months. ` +
  `Create discount links, track referrals and request cash payouts from $${program.minimumPayoutUsd}.`;
const socialImage = {
  url: "/og/affiliates.png",
  width: 1200,
  height: 630,
  alt: "OpenShip Earn. Share OpenShip. Get rewarded. Earn up to 20% on eligible Cloud payments.",
};

export const metadata: Metadata = {
  title: "Earn — Affiliate program",
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
    title: "Make your link.",
    copy: "Join from your Cloud account. Keep the full commission or share part as a customer discount. Choose all eligible plans or specific plans and billing intervals.",
  },
  {
    icon: Repeat2,
    title: "Share something useful.",
    copy: "Add your link to a tutorial, newsletter or recommendation. Your audience sees the eligible Cloud plans and their discount before signing in and checking out.",
  },
  {
    icon: BarChart3,
    title: "Follow every reward.",
    copy: "Track referred customers, confirmed payments, renewals and earnings in your dashboard. Request a cash payout when your available balance reaches your minimum.",
  },
];

const questions = [
  {
    question: "How do I join?",
    answer:
      "Sign in or create an OpenShip Cloud account, open Earn and choose Join the program. Review your program terms, then create your first referral link. You can share a link or its referral code.",
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
                <p className={styles.eyebrow}>
                  <Gift size={18} aria-hidden="true" />
                  OpenShip Earn
                </p>
                <h1 id="affiliate-title" className={styles.heroTitle}>
                  Share OpenShip.
                  <br />
                  <span>Get rewarded.</span>
                </h1>
                <p className={styles.heroCopy}>
                  You bring the community. We bring the cloud.
                  <br className={styles.desktopBreak} />
                  Earn from the people you send our way.
                </p>
                <div className={styles.actions}>
                  <a href={program.joinUrl} className={styles.primaryButton}>
                    Become an affiliate <ArrowRight size={19} aria-hidden="true" />
                  </a>
                  <a href="#how-it-works" className={styles.textLink}>
                    See how it works
                  </a>
                </div>
              </div>
              <div className={styles.reward}>
                <p className={styles.rewardLabel}>Earn up to</p>
                <p className={styles.rewardValue}>
                  {program.commissionPercent}
                  <span>%</span>
                </p>
                <p className={styles.rewardCaption}>on eligible Cloud payments.</p>
                <p className={styles.rewardNote}>
                  First payment + renewals within {program.rewardMonths} months
                </p>
              </div>
            </div>
            <dl className={styles.facts}>
              <div>
                <dt>Reward period</dt>
                <dd>{program.rewardMonths} months per referral</dd>
              </div>
              <div>
                <dt>Eligible subscriptions</dt>
                <dd>Monthly &amp; annual Cloud plans</dd>
              </div>
              <div>
                <dt>Default cash payout minimum</dt>
                <dd>${program.minimumPayoutUsd}, reviewed by OpenShip</dd>
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
              From a good word
              <br />
              to your next reward.
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
            <p className={styles.eyebrow}>Good for you. Good for them.</p>
            <h2 id="split-title">
              Your link.
              <br />
              Your way to share.
            </h2>
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
            <p className={styles.eyebrow}>When you earn</p>
            <h2 id="timing-title">
              The payment counts.
              <br />
              You don&apos;t wait for the year to end.
            </h2>
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
            <p className={styles.eyebrow}>Your earnings, paid out</p>
            <h2 id="payout-title">
              From recommendations
              <br />
              to cash payouts.
            </h2>
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
            <p className={styles.eyebrow}>
              <Gift size={18} aria-hidden="true" />
              OpenShip Earn
            </p>
            <h2 id="join-title">
              A good recommendation
              <br />
              deserves a reward.
            </h2>
          </div>
          <a href={program.joinUrl} className={styles.primaryButton}>
            Create your first link <ArrowRight size={19} aria-hidden="true" />
          </a>
        </section>
      </main>
      <Footer />
    </>
  );
}
