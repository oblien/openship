import {
  Navbar,
  Hero,
  Features,
  Dashboard,
  HowItWorks,
  WhyOpenship,
  DeveloperExperience,
  NoLockin,
  Scaling,
  Backups,
  Portability,
  Infrastructure,
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
        <DeveloperExperience />
        <NoLockin />
        <Scaling />
        <Backups />
        <Portability />
        <Infrastructure />
        <OpenSourceCta />
        <ComingSoon />
        <FinalCta />
      </main>
      <Footer />
    </>
  );
}
