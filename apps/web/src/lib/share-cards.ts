import type { ShareCard } from "./og-image";

// Badge URLs can carry repository or catalog parameters. Both share this static cover.
export const deployCard = {
  title: "Deploy with",
  secondLine: "OpenShip.",
  subtitle: "Launch this project on OpenShip Cloud\nor a server you manage.",
  art: { object: "deploy" },
} satisfies ShareCard;

export const referralCard = {
  eyebrow: "Referral program",
  title: "Good tools are worth sharing.",
  subtitle: "Introduce someone to OpenShip. A small thank-you for making the connection.",
  art: { object: "referrals" },
  layout: "reverse",
} satisfies ShareCard;

export const sectionCards = {
  login: { title: "Sign in to OpenShip.", art: { feature: "two-factor-auth" }, layout: "reverse" },
  about: {
    title: "About OpenShip.",
    subtitle: "An open source platform for deploying and running your apps.",
    art: { object: "about" },
  },
  apps: {
    title: "Find your next app.",
    eyebrow: "App catalog",
    subtitle: "Ready-to-deploy apps for Cloud or your own servers.",
    art: { feature: "app-catalog" },
    layout: "reverse",
  },
  features: {
    title: "Inside OpenShip.",
    eyebrow: "Features",
    subtitle: "Explore the tools for deploying, running and managing your stack.",
    art: { feature: "project-environments" },
    layout: "masthead",
  },
  compare: {
    title: "Compare platforms.",
    subtitle: "See how OpenShip compares with other ways to run your apps.",
    art: { object: "compare" },
  },
  mail: {
    title: "Your email.",
    secondLine: "Your control panel.",
    art: { object: "mail" },
    layout: "reverse",
  },
  "mail/setup-guide/android": {
    eyebrow: "Mail setup",
    title: "Gmail on Android.",
    art: { object: "android" },
  },
  "mail/setup-guide/ios": {
    eyebrow: "Mail setup",
    title: "Apple Mail on iOS and macOS.",
    art: { object: "ios" },
    layout: "reverse",
  },
  "mail/setup-guide/desktop": {
    eyebrow: "Mail setup",
    title: "Desktop mail clients.",
    art: { object: "desktop" },
  },
  "mail/setup-guide/nodemailer": {
    eyebrow: "Mail setup",
    title: "Send with Nodemailer.",
    art: { object: "nodemailer" },
    layout: "reverse",
  },
  contact: {
    title: "Get in touch.",
    eyebrow: "Contact",
    art: { object: "contact" },
    layout: "reverse",
  },
  support: {
    title: "Customer support.",
    subtitle: "Get help with deployments, your account or billing.",
    art: { object: "support" },
  },
  trust: {
    title: "Trust and security.",
    subtitle: "How OpenShip handles data ownership and access.",
    art: { object: "trust" },
    layout: "reverse",
  },
  sla: {
    title: "Cloud uptime.",
    eyebrow: "Service level agreement",
    subtitle: "The uptime commitment for OpenShip Cloud plans.",
    art: { object: "uptime" },
  },
  privacy: { title: "Privacy policy.", art: { object: "privacy" }, layout: "reverse" },
  terms: { title: "Terms of service.", art: { object: "terms" } },
  blog: {
    title: "The OpenShip blog.",
    subtitle: "Stories and guides from the team.",
    art: { object: "journal" },
    layout: "reverse",
  },
  changelog: {
    title: "What’s new.",
    eyebrow: "Changelog",
    subtitle: "Release notes, improvements and fixes.",
    art: { object: "releases" },
  },
} satisfies Record<string, ShareCard>;

export function sectionCard(key: string): ShareCard | undefined {
  return Object.hasOwn(sectionCards, key)
    ? sectionCards[key as keyof typeof sectionCards]
    : undefined;
}

/** Page metadata only references a renderable card, leaving file-based previews to Next. */
export function shareImageFor(path: string) {
  const key = path.replace(/^\//, "");
  if (key === "deploy") {
    return { url: "/og/deploy.png", width: 1200, height: 630, alt: "Deploy with OpenShip" };
  }
  const card = sectionCard(key);
  if (!card && !/^(apps|features|blog|changelog)\/[\w-]+(?:\/[\w-]+)*$/.test(key)) return;
  return {
    url: `/share/${key}`,
    width: 1200,
    height: 630,
    alt: card ? [card.title, card.secondLine].filter(Boolean).join(" ") : undefined,
  };
}
