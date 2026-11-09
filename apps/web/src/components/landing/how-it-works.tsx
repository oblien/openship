"use client";

import Image from "next/image";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import connectScreenshot from "../../../public/walkthrough/connect.jpg";
import buildScreenshot from "../../../public/walkthrough/build.jpg";
import shipScreenshot from "../../../public/walkthrough/ship.jpg";
import routeScreenshot from "../../../public/walkthrough/route.jpg";
import operateScreenshot from "../../../public/walkthrough/operate.jpg";

const STEPS = [
  {
    id: "connect",
    label: "Connect",
    title: "Start with your code.",
    body: "Link a repository, choose a branch, and pick Openship Cloud or a connected server. Review the detected framework and settings before you deploy.",
    image: connectScreenshot,
    alt: "Openship’s repository picker showing sample applications ready to import.",
    caption: "Choose a repository",
    guide: "/docs/getting-started/first-deployment",
  },
  {
    id: "build",
    label: "Build",
    title: "Follow every build.",
    body: "Build on your machine, a connected server, or Cloud. Follow the output as it happens, see the current phase, and keep the deployment history with your project.",
    image: buildScreenshot,
    alt: "A sample deployment’s build progress and production build logs in Openship.",
    caption: "Build progress and logs",
    guide: "/docs/guides/actions",
  },
  {
    id: "ship",
    label: "Ship",
    title: "From image to running app.",
    body: "Deploy the built image to your chosen destination. Track startup and health checks in the same deployment view, then open the app when it’s ready.",
    image: shipScreenshot,
    alt: "A ready deployment with its destination, build duration, framework, and domain.",
    caption: "A deployment, ready to serve",
    guide: "/docs/guides/rollback-redeploy",
  },
  {
    id: "route",
    label: "Route",
    title: "Give it a home on the web.",
    body: "Add your domain, review the route, and let Openship manage HTTPS. Your domain and port settings stay with the project.",
    image: routeScreenshot,
    alt: "Domain settings for shop.example.com, including its exposed port and DNS instructions.",
    caption: "Domains and routing",
    guide: "/docs/guides/custom-domains",
  },
  {
    id: "operate",
    label: "Operate",
    title: "Keep production in view.",
    body: "Watch resource usage and service health, inspect logs, and redeploy or roll back from the same dashboard. The tools you need stay with your app after launch.",
    image: operateScreenshot,
    alt: "Sample project monitoring with CPU, memory, network, and resource history.",
    caption: "Resources and monitoring",
    guide: "/docs/guides/logs-monitoring",
  },
];

// Keep this query in sync with the sticky layout in landing.css. Short viewports
// use the same inline screenshots as mobile, so the preview never traps content.
const STICKY_LAYOUT = "(min-width: 901px) and (min-height: 650px)";

export function HowItWorks() {
  const [activeStep, setActiveStep] = useState(0);
  const stepRefs = useRef<(HTMLLIElement | null)[]>([]);

  useEffect(() => {
    const layout = window.matchMedia(STICKY_LAYOUT);
    let observer: IntersectionObserver | undefined;
    const selectNearest = () => {
      const center = window.innerHeight / 2;
      let nearest = 0;
      let distance = Infinity;
      stepRefs.current.forEach((step, index) => {
        if (!step) return;
        const bounds = step.getBoundingClientRect();
        const next = Math.abs(bounds.top + bounds.height / 2 - center);
        if (next < distance) {
          nearest = index;
          distance = next;
        }
      });
      setActiveStep(nearest);
    };
    const observe = () => {
      observer?.disconnect();
      if (!layout.matches) return;
      observer = new IntersectionObserver(selectNearest, {
        // A narrow band at the viewport center switches steps at their boundary.
        rootMargin: `-${(window.innerHeight - 2) / 2}px 0px`,
      });
      stepRefs.current.forEach((step) => step && observer?.observe(step));
      selectNearest();
    };
    observe();
    layout.addEventListener("change", observe);
    window.addEventListener("resize", observe);
    return () => {
      observer?.disconnect();
      layout.removeEventListener("change", observe);
      window.removeEventListener("resize", observe);
    };
  }, []);

  const goToStep = (index: number) => {
    stepRefs.current[index]?.scrollIntoView({
      block: "center",
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
  };

  return (
    <section id="how-it-works" className="hiw-section" aria-labelledby="hiw-title">
      <div className="site-container">
        <header className="hiw-head">
          <p className="hiw-eyebrow">How it works</p>
          <h2 id="hiw-title" className="hiw-title">
            From git push to live,
            <br />
            <span>on your infrastructure.</span>
          </h2>
          <p className="hiw-sub">
            Connect your code, choose a destination, and follow every deployment from build logs to
            a healthy app.
          </p>
        </header>

        <div className="hiw-walkthrough">
          <ol className="hiw-flow">
            {STEPS.map((step, index) => (
              <li
                id={`workflow-${step.id}`}
                key={step.id}
                ref={(element) => {
                  stepRefs.current[index] = element;
                }}
                className="hiw-step"
                data-active={activeStep === index}
              >
                <div className="hiw-step-copy">
                  <p className="hiw-step-label">
                    <span className="hiw-step-n">{String(index + 1).padStart(2, "0")}</span>
                    {step.label}
                  </p>
                  <h3 className="hiw-step-title">{step.title}</h3>
                  <p className="hiw-step-desc">{step.body}</p>
                  <Link href={step.guide} className="hiw-guide">
                    Read the guide <ArrowRight size={16} aria-hidden="true" />
                  </Link>
                </div>
                <figure className="hiw-inline-preview">
                  <Image
                    src={step.image}
                    alt={step.alt}
                    width={1800}
                    height={1350}
                    sizes="(max-width: 900px) calc(100vw - 48px), 720px"
                  />
                  <figcaption>{step.caption}</figcaption>
                </figure>
              </li>
            ))}
          </ol>

          <figure className="hiw-preview">
            <div className="hiw-preview-screen">
              {STEPS.map((step, index) => (
                <div
                  key={step.id}
                  className="hiw-slide"
                  data-active={activeStep === index}
                  aria-hidden={activeStep !== index}
                >
                  <Image
                    src={step.image}
                    alt={step.alt}
                    fill
                    sizes="(max-width: 1100px) 52vw, 720px"
                  />
                </div>
              ))}
            </div>
            <figcaption className="hiw-preview-caption">
              <span>{STEPS[activeStep].caption}</span>
              <div className="hiw-preview-controls" role="group" aria-label="Walkthrough steps">
                {STEPS.map((step, index) => (
                  <button
                    key={step.id}
                    type="button"
                    aria-label={`Show step ${index + 1}: ${step.label}`}
                    aria-pressed={activeStep === index}
                    onClick={() => goToStep(index)}
                  >
                    <span />
                  </button>
                ))}
              </div>
            </figcaption>
          </figure>
        </div>
      </div>
    </section>
  );
}
