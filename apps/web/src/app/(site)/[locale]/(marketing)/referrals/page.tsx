import { getCopy } from "@/i18n/copy-server";
import { useCopy } from "@/i18n/use-copy";
import type { Copy } from "@/i18n/copy";
import { localizedMetadata } from "@/i18n/metadata";

import type { Metadata } from "next";
import { Link } from "@/i18n/Link";
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
import { REFERRAL_PROGRAM as program } from "@/lib/referral-program";
import { CommissionPreview } from "./commission-preview";
import styles from "./referrals.module.css";

const title = "OpenShip Referral — Good tools are worth sharing.";
const description =
  "Introduce someone to OpenShip. Share a useful tool, offer an optional discount, " +
  `and receive up to ${program.commissionPercent}% commission on eligible Cloud payments for ${program.rewardMonths} months.`;

const pageMetadata: Metadata = {
  title: "Referral program",
  description,
  alternates: { canonical: "/referrals" },
  openGraph: {
    title,
    description,
    url: "/referrals",
    siteName: "OpenShip",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    site: "@openshipio",
    creator: "@openshipio",
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

function getQuestions(copy: Copy) {
  return [
    {
      question: copy("How do I join?"),
      answer: copy(
        "Sign in or create an OpenShip Cloud account, open Referral in your account and choose Join the program. Review your program terms, then create your first referral link. You can share a link or its referral code.",
      ),
    },
    {
      question: copy("Which purchases qualify?"),
      answer: copy(
        "Qualifying monthly and annual Cloud plans, starting at ${value0} per month equivalent (${value1} per year before discounts). Manage plans, credit top-ups, free plans and plan-change prorations are excluded. You cannot refer yourself or a workspace you belong to.",
        {
          value0: String(program.minimumMonthlyPlanUsd),
          value1: String(program.minimumMonthlyPlanUsd * 12),
        },
      ),
    },
    {
      question: copy("Does an annual plan earn commission?"),
      answer: copy(
        "Yes. Commission is calculated on the eligible full annual payment and credited after that payment is verified; you do not wait until the year ends. With the current {value0}-month reward period, the first annual payment qualifies, while the renewal a year later falls outside the window.",
        { value0: String(program.rewardMonths) },
      ),
    },
    {
      question: copy("When does the reward period start?"),
      answer: copy(
        "Each referred customer's {value0}-month period begins with their first eligible payment. Confirmed renewals within that period also qualify. Creating a link earlier, renewing or changing plans does not restart the period.",
        { value0: String(program.rewardMonths) },
      ),
    },
    {
      question: copy("How do discounts affect my commission?"),
      answer: copy(
        "The customer discount comes from the {value0}% commission budget. For example, a 5% discount leaves you 15% of the eligible pretax subtotal. With no discount, you keep the full {value1}%. Earnings are based on verified eligible payments and can be adjusted for refunds.",
        { value0: String(program.commissionPercent), value1: String(program.commissionPercent) },
      ),
    },
    {
      question: copy("How and when do I receive a payout?"),
      answer: copy(
        "Save a payout destination, then request a payout once your available earnings reach your minimum. The default is ${value0}; your dashboard shows any individually approved terms. OpenShip manually reviews and pays requests. PayPal, bank transfer, Wise and Payoneer are supported destinations, subject to country and provider availability. Earnings are not an automatic cash transfer.",
        { value0: String(program.minimumPayoutUsd) },
      ),
    },
    {
      question: copy("Can I change or revoke a referral link?"),
      answer: copy(
        "You can revoke a link to stop new referrals. Create a new link if you want different terms or plan selections. Revoking a link does not change accepted checkouts or the terms of customers already referred through it.",
      ),
    },
  ];
}

export default function ReferralsPage() {
  const copy = useCopy();
  const questions = getQuestions(copy);

  return (
    <>
      <Navbar />
      <main className={styles.root}>
        <section className={styles.hero} aria-labelledby="referral-title">
          <div className={styles.container}>
            <div className={styles.heroGrid}>
              <div>
                <p className={styles.eyebrow}>{copy("OpenShip Referral")}</p>
                <h1 id="referral-title" className={styles.heroTitle}>
                  {copy("Good tools are")}
                  <br />
                  <span>{copy("worth sharing.")}</span>
                </h1>
                <p className={styles.heroCopy}>
                  {copy(
                    "Help someone find a better way to deploy. Our referral program is a small thank-you for making the introduction.",
                  )}
                </p>
                <div className={styles.actions}>
                  <a href={program.joinUrl} className={styles.primaryButton}>
                    {copy("Join the program ")}
                    <ArrowRight size={17} aria-hidden="true" />
                  </a>
                  <a href="#how-it-works" className={styles.textLink}>
                    {copy("How it works ")}
                    <ArrowRight size={16} aria-hidden="true" />
                  </a>
                </div>
                <p className={styles.heroNote}>
                  {copy("For developers, educators, and people who build.")}
                </p>
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
                    <strong>{copy("Your recommendation")}</strong>
                    <span>{copy("A guide. A project. A good word.")}</span>
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
                    <strong>{copy("Their next deployment")}</strong>
                    <span>{copy("A new home on OpenShip Cloud.")}</span>
                  </div>
                  <ArrowRight size={16} />
                </div>
                <p className={styles.connectionCaption}>
                  {copy("Good things travel by word of mouth.")}
                </p>
              </div>
            </div>
            <dl className={styles.facts}>
              <div>
                <dt>{copy("Commission")}</dt>
                <dd>
                  {copy("Up to ")}
                  {program.commissionPercent}%<span>{copy("on eligible Cloud payments")}</span>
                </dd>
              </div>
              <div>
                <dt>{copy("Referral period")}</dt>
                <dd>
                  {copy("{months} months", { months: program.rewardMonths })}
                  <span>{copy("from their first eligible payment")}</span>
                </dd>
              </div>
              <div>
                <dt>{copy("Payouts")}</dt>
                <dd>
                  {copy("From $")}
                  {program.minimumPayoutUsd}
                  <span>{copy("requested by you, reviewed by us")}</span>
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
            <p className={styles.eyebrow}>{copy("How it works")}</p>
            <h2 id="steps-title">
              {copy("A thoughtful introduction.")}
              <br />
              {copy("A straightforward program.")}
            </h2>
          </div>
          <ol className={styles.steps}>
            {steps.map(({ icon: Icon, title: stepTitle, copy: description }, index) => (
              <li key={stepTitle}>
                <div className={styles.stepTop}>
                  <Icon size={24} aria-hidden="true" />
                  <span>0{index + 1}</span>
                </div>
                <h3>{copy(stepTitle)}</h3>
                <p>{copy(description)}</p>
              </li>
            ))}
          </ol>
        </section>

        <section
          className={`${styles.container} ${styles.splitSection}`}
          aria-labelledby="split-title"
        >
          <div className={styles.splitIntro}>
            <p className={styles.eyebrow}>{copy("A little flexibility")}</p>
            <h2 id="split-title">{copy("Make the link your own.")}</h2>
            <p>
              {copy("Keep the full ")}
              {program.commissionPercent}
              {copy(
                "% commission, or give your audience a discount from that budget. You choose the split when you create a link.",
              )}
            </p>
            <ul className={styles.checkList}>
              <li>
                <Check size={18} aria-hidden="true" />{" "}
                {copy(" Choose individual plans and billing intervals")}
              </li>
              <li>
                <Check size={18} aria-hidden="true" />{" "}
                {copy(" Set an optional expiration for new referrals")}
              </li>
              <li>
                <Check size={18} aria-hidden="true" />{" "}
                {copy(" See estimated earnings before sharing")}
              </li>
            </ul>
          </div>
          <CommissionPreview />
        </section>

        <section className={`${styles.container} ${styles.section}`} aria-labelledby="timing-title">
          <div className={styles.sectionHeading}>
            <p className={styles.eyebrow}>{copy("The details, upfront")}</p>
            <h2 id="timing-title">{copy("Clear from the first payment.")}</h2>
            <p>
              {copy(
                "Earnings start when an eligible payment is verified. Cash payouts are requested separately.",
              )}
            </p>
          </div>
          <div className={styles.timingGrid}>
            <article className={styles.timingCard}>
              <Repeat2 size={26} aria-hidden="true" />
              <h3>{copy("Monthly subscriptions")}</h3>
              <p>
                {copy(
                  "Earn on the first eligible payment and confirmed renewals within each customer's original ",
                )}
                {program.rewardMonths}
                {copy("-month reward period.")}
              </p>
              <div
                className={styles.timeline}
                aria-label={copy("First payment followed by eligible monthly renewals")}
              >
                <span>{copy("First payment")}</span>
                <ArrowRight size={18} aria-hidden="true" />
                <span>{copy("Eligible renewals")}</span>
              </div>
            </article>
            <article className={styles.timingCard}>
              <Wallet size={26} aria-hidden="true" />
              <h3>{copy("Annual subscriptions")}</h3>
              <p>
                {copy("Earn on the full eligible annual charge after verification. With a")}{" "}
                {program.rewardMonths}
                {copy("-month reward period, the next annual renewal is outside the window.")}
              </p>
              <div
                className={styles.timeline}
                aria-label={copy("The first full annual payment earns commission")}
              >
                <Check size={18} aria-hidden="true" />
                <span>{copy("Full first annual payment")}</span>
              </div>
            </article>
          </div>
        </section>

        <section
          className={`${styles.container} ${styles.payoutSection}`}
          aria-labelledby="payout-title"
        >
          <div>
            <p className={styles.eyebrow}>{copy("Payouts")}</p>
            <h2 id="payout-title">{copy("Know where you stand.")}</h2>
            <p>
              {copy(
                "Save your payout account, reach your minimum, then submit a request. We review each request and arrange the payment.",
              )}
            </p>
            <div
              className={styles.methods}
              aria-label={copy("Supported manual payout destinations")}
            >
              <span>{copy("PayPal")}</span>
              <span>{copy("Bank transfer")}</span>
              <span>{copy("Wise")}</span>
              <span>{copy("Payoneer")}</span>
            </div>
            <p className={styles.methodNote}>
              {copy("Availability depends on your country and payment provider.")}
            </p>
          </div>
          <div className={styles.payoutCard}>
            <Wallet size={27} aria-hidden="true" />
            <p className={styles.payoutAmount}>
              ${program.minimumPayoutUsd}
              <span>{copy("default minimum")}</span>
            </p>
            <p>
              {copy(
                "Your dashboard shows your available balance, pending requests and completed payouts, along with your account's current payout minimum.",
              )}
            </p>
            <Link href={program.guideUrl} className={styles.textLink}>
              {copy("Read the payout guide ")}
              <ArrowRight size={17} aria-hidden="true" />
            </Link>
          </div>
        </section>

        <section className={`${styles.container} ${styles.faqSection}`} aria-labelledby="faq-title">
          <div className={styles.sectionHeading}>
            <p className={styles.eyebrow}>{copy("A few useful details")}</p>
            <h2 id="faq-title">{copy("Before you share.")}</h2>
          </div>
          <div className={styles.faqList}>
            {questions.map(({ question, answer }) => (
              <details key={question}>
                <summary>
                  {copy(question)}
                  <ChevronDown size={19} aria-hidden="true" />
                </summary>
                <p>{copy(answer)}</p>
              </details>
            ))}
          </div>
          <p className={styles.termsNote}>
            {copy(
              "Current program terms are shown in your Cloud account before you join and create a link.",
            )}
          </p>
        </section>

        <section className={`${styles.container} ${styles.finalCta}`} aria-labelledby="join-title">
          <div>
            <p className={styles.eyebrow}>{copy("OpenShip Referral")}</p>
            <h2 id="join-title">{copy("Have someone in mind?")}</h2>
            <p className={styles.finalCopy}>
              {copy("Share OpenShip when it feels like the right fit.")}
            </p>
          </div>
          <a href={program.joinUrl} className={styles.primaryButton}>
            {copy("Join the program ")}
            <ArrowRight size={17} aria-hidden="true" />
          </a>
        </section>
      </main>
      <Footer />
    </>
  );
}

export async function generateMetadata() {
  const copy = await getCopy();
  const description = copy(
    "Introduce someone to OpenShip. Share a useful tool, offer an optional discount, and receive up to {commission}% commission on eligible Cloud payments for {months} months.",
    {
      commission: program.commissionPercent,
      months: program.rewardMonths,
    },
  );
  return localizedMetadata({
    ...pageMetadata,
    description,
    openGraph: { ...pageMetadata.openGraph, description },
    twitter: { ...pageMetadata.twitter, description },
  });
}
