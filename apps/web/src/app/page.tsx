import {
  Navbar,
  Hero,
  Features,
  Dashboard,
  HowItWorks,
  WhyOpenship,
  AiNative,
  DeveloperExperience,
  Pricing,
  NoLockin,
  Scaling,
  Backups,
  Portability,
  MailServer,
  Cdn,
  DnsDomains,
  OpenSourceCta,
  ComingSoon,
  FinalCta,
  Footer,
} from "@/components/landing";

export default function HomePage() {
  return (
    <>
      <Navbar />
      <main>
        <Hero />
        <Features />
        <Dashboard />
        <HowItWorks />
        <WhyOpenship />
        <AiNative />
        <DeveloperExperience />
        <Pricing />
        <NoLockin />
        <Scaling />
        <Backups />
        <Portability />
        <MailServer />
        <Cdn />
        <DnsDomains />
        <OpenSourceCta />
        <ComingSoon />
        <FinalCta />
      </main>
      <Footer />
    </>
  );
}
