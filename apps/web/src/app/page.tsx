import {
  Navbar,
  Hero,
  Features,
  HowItWorks,
  AiNative,
  DeveloperExperience,
  OpenSourceCta,
  Footer,
} from "@/components/landing";

export default function HomePage() {
  return (
    <>
      <Navbar />
      <main>
        <Hero />
        <Features />
        <HowItWorks />
        <AiNative />
        <DeveloperExperience />
        <OpenSourceCta />
      </main>
      <Footer />
    </>
  );
}
