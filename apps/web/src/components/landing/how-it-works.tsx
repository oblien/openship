"use client";

import Image, { getImageProps } from "next/image";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import connectScreenshot from "../../../public/walkthrough/connect-light.jpg";
import buildScreenshot from "../../../public/walkthrough/build-light.jpg";
import shipScreenshot from "../../../public/walkthrough/ship-light.jpg";
import routeScreenshot from "../../../public/walkthrough/route-light.jpg";
import operateScreenshot from "../../../public/walkthrough/operate-light.jpg";
import connectDarkScreenshot from "../../../public/walkthrough/connect.jpg";
import buildDarkScreenshot from "../../../public/walkthrough/build.jpg";
import shipDarkScreenshot from "../../../public/walkthrough/ship.jpg";
import routeDarkScreenshot from "../../../public/walkthrough/route.jpg";
import operateDarkScreenshot from "../../../public/walkthrough/operate.jpg";

const STEPS = [
  {
    id: "connect",
    label: "Connect",
    title: "Start with your code.",
    body: "Link a repository, choose a branch, and pick Openship Cloud or a connected server. Review the detected framework and settings before you deploy.",
    image: connectScreenshot,
    darkImage: connectDarkScreenshot,
    alt: "Openship’s repository picker with personal and organization accounts, avatars, and sample applications ready to import.",
    caption: "Choose a repository",
    guide: "/docs/getting-started/first-deployment",
  },
  {
    id: "build",
    label: "Build",
    title: "Follow every build.",
    body: "Build on your machine, a connected server, or Cloud. Follow the output as it happens, see the current phase, and keep the deployment history with your project.",
    image: buildScreenshot,
    darkImage: buildDarkScreenshot,
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
    darkImage: shipDarkScreenshot,
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
    darkImage: routeDarkScreenshot,
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
    darkImage: operateDarkScreenshot,
    alt: "Sample project monitoring with CPU, memory, network, and resource history.",
    caption: "Resources and monitoring",
    guide: "/docs/guides/logs-monitoring",
  },
];

// Keep this query in sync with the sticky layout in landing.css. Short viewports
// use the same inline screenshots as mobile, so the preview never traps content.
const STICKY_LAYOUT = "(min-width: 901px) and (min-height: 650px)";
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function subscribeToMotionPreference(onChange: () => void) {
  const preference = window.matchMedia(REDUCED_MOTION);
  preference.addEventListener("change", onChange);
  return () => preference.removeEventListener("change", onChange);
}
const readMotionPreference = () => window.matchMedia(REDUCED_MOTION).matches;
const serverMotionPreference = () => true;

type Step = (typeof STEPS)[number];

type CardTone = "light" | "dark";

function companionStep(step: Step): Step {
  const index = STEPS.indexOf(step);
  return STEPS[index === STEPS.length - 1 ? index - 1 : index + 1];
}

function screenProps(step: Step, tone: CardTone) {
  return {
    src: tone === "light" ? step.image : step.darkImage,
    alt: step.alt,
    sizes: "(max-width: 900px) 80vw, (max-width: 1300px) 45vw, 620px",
  };
}

async function prepareScreen(step: Step) {
  const { src, srcSet, sizes } = getImageProps(screenProps(step, "light")).props;
  const image = new window.Image();
  image.sizes = sizes ?? "";
  image.srcset = srcSet ?? "";
  image.src = src;
  await image.decode();
}

function WalkthroughScreens({
  step,
  animated = false,
  reducedMotion = true,
}: {
  step: Step;
  animated?: boolean;
  reducedMotion?: boolean;
}) {
  const [shownStep, setShownStep] = useState(step);
  const [backgroundStep] = useState(() => companionStep(step));

  useEffect(() => {
    if (!animated || step.id === shownStep.id) return;
    let current = true;
    // Fade only decoded screenshots, ignoring superseded requests.
    prepareScreen(step).then(
      () => {
        if (!current) return;
        setShownStep(step);
      },
      () => {
        // diagnostics-ignore: Screenshot preloading is optional; retain the
        // complete visible card if the next image cannot be decoded.
      },
    );
    return () => {
      current = false;
    };
  }, [animated, step, shownStep.id]);

  const foregroundStep = animated ? shownStep : step;

  return (
    <div className="hiw-screens">
      <div className="hiw-screen hiw-screen--back" aria-hidden="true">
        <Image {...screenProps(backgroundStep, "dark")} alt="" />
      </div>
      <div
        className="hiw-screen hiw-screen--front"
        data-step={foregroundStep.id}
        role="img"
        aria-label={foregroundStep.alt}
      >
        <AnimatePresence initial={false}>
          <motion.div
            key={foregroundStep.id}
            className="hiw-screen-frame"
            initial={{ opacity: animated && !reducedMotion ? 0 : 1 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: animated && !reducedMotion ? 0.16 : 0, ease: "easeInOut" }}
          >
            <Image {...screenProps(foregroundStep, "light")} alt="" />
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

export function HowItWorks() {
  const [activeStep, setActiveStep] = useState(0);
  const stepRefs = useRef<(HTMLLIElement | null)[]>([]);
  const reducedMotion = useSyncExternalStore(
    subscribeToMotionPreference,
    readMotionPreference,
    serverMotionPreference,
  );

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
      behavior: reducedMotion ? "instant" : "smooth",
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
                <span className="hiw-step-n" aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div className="hiw-step-copy">
                  <p className="hiw-step-label">{step.label}</p>
                  <h3 className="hiw-step-title">{step.title}</h3>
                  <p className="hiw-step-desc">{step.body}</p>
                  <Link href={step.guide} className="hiw-guide">
                    Read the guide <ArrowRight size={16} aria-hidden="true" />
                  </Link>
                </div>
                <figure className="hiw-inline-preview">
                  <WalkthroughScreens step={step} />
                  <figcaption>{step.caption}</figcaption>
                </figure>
              </li>
            ))}
          </ol>

          <figure className="hiw-preview">
            <WalkthroughScreens step={STEPS[activeStep]} animated reducedMotion={reducedMotion} />
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
