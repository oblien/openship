/**
 * Content for /migrate — the page for teams moving an existing app to Openship Cloud.
 * Situations are written around the problem a visitor has, never around another vendor's name.
 */

export type Mark = "strong" | "limited" | "weak";

export interface Situation {
  /** Hash used for deep links, e.g. /migrate#limits */
  id: "bill" | "limits" | "split" | "jobs" | "lock";
  title: string;
  hint: string;
  quote: string;
  problems: { lead: string; rest: string }[];
  fixes: { lead: string; rest: string }[];
  footNote: string;
  footLink: { label: string; href: string };
}

export function situations(from: string | null): Situation[] {
  const fromLabel = from ? `from ${from}/mo` : "on every plan";
  return [
    {
      id: "bill",
      title: "The bill grows with your traffic",
      hint: "A good week turns into a big invoice.",
      quote: "Our launch went well. Then the hosting invoice arrived.",
      problems: [
        {
          lead: "You pay per request,",
          rest: " per second of function time and per GB, so every traffic spike becomes a cost spike.",
        },
        { lead: "You pay per seat.", rest: " Every developer you hire adds to the bill." },
        {
          lead: "You can’t predict it.",
          rest: " You learn what the month cost when the month is over.",
        },
      ],
      fixes: [
        {
          lead: "You pay for a server, not for requests.",
          rest: ` Fixed CPU, RAM and storage ${fromLabel}, shared by all your apps.`,
        },
        { lead: "Unlimited team members", rest: " on every plan. Never pay per seat." },
        {
          lead: "Usage in your dashboard",
          rest: " as it happens, so there are no surprises at the end of the month.",
        },
      ],
      footNote:
        "Straight answer: managed proxy transfer and backups are billed on top of the plan.",
      footLink: { label: "How billing works", href: "/docs/guides/billing" },
    },
    {
      id: "limits",
      title: "Your app hit a limit",
      hint: "Memory caps, missing Node APIs, a forced rewrite.",
      quote: "We moved to save money. Then we spent two weeks making our app fit.",
      problems: [
        {
          lead: "A memory cap as low as 128 MB",
          rest: " per request. Go over it and requests fail with resource-limit errors.",
        },
        {
          lead: "Not a full Node.js runtime.",
          rest: " Some packages and Node APIs don’t work, or need compatibility flags.",
        },
        {
          lead: "Your framework needs an adapter,",
          rest: " and features like caching and image handling need rework.",
        },
      ],
      fixes: [
        { lead: "4 to 32 GB of RAM", rest: " on your server, depending on the plan." },
        {
          lead: "A normal container with full Node.js.",
          rest: " Next.js runs as a standard Node server, with no adapter.",
        },
        {
          lead: "Your code as it runs on your laptop.",
          rest: " Remove the workarounds instead of adding more.",
        },
      ],
      footNote: "Also runs Python, Go, Rust, Rails, Laravel, Django, Bun and any Dockerfile.",
      footLink: { label: "Read the docs", href: "/docs" },
    },
    {
      id: "split",
      title: "Your app lives on three services",
      hint: "Frontend here, API there, database somewhere else.",
      quote: "I pay three bills and copy the same secrets into three dashboards.",
      problems: [
        {
          lead: "The frontend moved, the backend couldn’t,",
          rest: " so now they live on different hosts.",
        },
        {
          lead: "Two or three bills, logins and dashboards.",
          rest: " Env vars copied by hand between them.",
        },
        {
          lead: "Your own services talk over the public internet,",
          rest: " which adds latency and exposure.",
        },
      ],
      fixes: [
        { lead: "The whole stack as one project:", rest: " app, worker, Postgres and Redis." },
        { lead: "A private network.", rest: " Services reach each other and never the internet." },
        { lead: "One dashboard and one bill", rest: " for logs, metrics and secrets." },
      ],
      footNote: "Ready-to-deploy templates, including Postgres, Redis and Supabase.",
      footLink: { label: "Browse the catalog", href: "/apps" },
    },
    {
      id: "jobs",
      title: "Long tasks don’t fit",
      hint: "Timeouts on jobs, queues, cron and websockets.",
      quote: "Our video export takes four minutes. Our function times out long before that.",
      problems: [
        {
          lead: "Functions have time limits,",
          rest: " so long jobs get cut off or split into pieces.",
        },
        {
          lead: "Queues, cron and websockets",
          rest: " each need a special product or a separate service.",
        },
        { lead: "Background workers", rest: " don’t fit a model built for short requests." },
      ],
      fixes: [
        { lead: "Long-running processes", rest: " are just containers that keep running." },
        { lead: "Scheduled jobs and webhook triggers", rest: " are built in, with live logs." },
        {
          lead: "Background jobs sit next to your app",
          rest: " and database on the same private network.",
        },
      ],
      footNote: "Logs, metrics and one-click rollback for every service.",
      footLink: { label: "See all features", href: "/features" },
    },
    {
      id: "lock",
      title: "You never want to move again",
      hint: "Your next host should be your last migration.",
      quote: "This is our second migration in a year. I don’t want a third.",
      problems: [
        { lead: "Platform-only code", rest: " makes every move a rewrite." },
        { lead: "Pricing and limits change", rest: " and you have no other option ready." },
        { lead: "You can’t see how it works", rest: " or run it anywhere else." },
      ],
      fixes: [
        {
          lead: "Plain containers and standard images.",
          rest: " Nothing Openship-only in your code.",
        },
        {
          lead: "Move from Cloud to your own servers",
          rest: " any day, with the same tool, for free.",
        },
        { lead: "Open source under Apache 2.0.", rest: " Read, audit or fork every line." },
      ],
      footNote: "15K+ developers have starred the project on GitHub.",
      footLink: { label: "View on GitHub", href: "https://github.com/oblien/openship" },
    },
  ];
}

export interface CompareRow {
  label: string;
  serverless: [Mark, string];
  edge: [Mark, string];
  openship: [Mark, string];
  /** Optional tag shown after the cell text, keyed by column */
  tag?: Partial<Record<"serverless" | "edge" | "openship", string>>;
}

/** General categories of hosting, not any one provider. */
export function compareRows(from: string | null): CompareRow[] {
  return [
    {
      label: "Cheapest start",
      serverless: ["limited", "Free tier, then per seat plus usage"],
      edge: ["strong", "A few dollars a month plus usage"],
      openship: [
        "limited",
        from ? `${from}/mo for a whole server` : "One price for a whole server",
      ],
      tag: { edge: "Cheapest" },
    },
    {
      label: "Predictable bill",
      serverless: ["weak", "Grows with traffic and team size"],
      edge: ["weak", "Grows with requests and CPU time"],
      openship: ["strong", "Fixed base price. Transfer and backups extra"],
      tag: { openship: "Most predictable" },
    },
    {
      label: "Memory",
      serverless: ["limited", "Set per function, within plan limits"],
      edge: ["weak", "As low as 128 MB per request"],
      openship: ["strong", "4 to 32 GB per server"],
      tag: { openship: "Most room" },
    },
    {
      label: "Runtime",
      serverless: ["limited", "Functions with time limits"],
      edge: ["weak", "Partial Node.js, adapters needed"],
      openship: ["strong", "Full runtime in a normal container"],
    },
    {
      label: "Jobs, cron, websockets",
      serverless: ["weak", "Separate products or add-ons"],
      edge: ["limited", "Separate products, its own model"],
      openship: ["strong", "Long-running processes and built-in cron"],
    },
    {
      label: "Database",
      serverless: ["limited", "Through partners"],
      edge: ["limited", "Its own databases, or connect one"],
      openship: ["strong", "Postgres and Redis on the same network"],
    },
    {
      label: "Global edge",
      serverless: ["strong", "Global network built in"],
      edge: ["strong", "Runs in hundreds of cities"],
      openship: ["limited", "One region per server, CDN in front if you want"],
      tag: { edge: "Strongest" },
    },
    {
      label: "Leaving later",
      serverless: ["limited", "Rework platform-specific features"],
      edge: ["weak", "Undo platform-only code"],
      openship: ["strong", "Plain containers. Self-host for free"],
      tag: { openship: "Easiest" },
    },
  ];
}

export const FIT_YES = [
  "Your app has a backend, a database or background jobs",
  "You want one bill that doesn’t jump with traffic",
  "You hit memory, time or runtime limits",
  "Your team is growing and per-seat pricing hurts",
  "You want the option to self-host later",
];

export const FIT_NO = [
  "Your site is static and fits a free tier today",
  "Your functions are small and well inside their limits",
  "You need code running in hundreds of cities at once",
];

export const STEPS = [
  {
    title: "Connect your repo",
    body: "GitHub, GitLab, any Git remote, or a local folder. Your stack is detected for you.",
  },
  {
    title: "Add your services",
    body: "Postgres, Redis or a worker join your app on a private network.",
  },
  {
    title: "Bring your env vars",
    body: "Paste them from your old host. Drop the adapters and workarounds you no longer need.",
  },
  {
    title: "Point your domain",
    body: "SSL is automatic. Traffic switches with zero downtime, and any version can be rolled back in one click.",
  },
];

export function faq(from: string | null) {
  return [
    {
      q: "Will Openship always be the cheapest option?",
      a: "No. A tiny app that fits a free tier or a few-dollar edge plan will cost less there. Openship makes sense once you need real memory, long-running work or a database next to your app. Then one server at a fixed base price usually beats paying for each piece, plus a second host.",
    },
    {
      q: "Do I have to rewrite my app?",
      a: "No. Your app runs in a normal container, the same way it runs on your machine. Next.js runs as a standard Node server. If you added adapters or platform-only code to fit your last host, you can usually remove them.",
    },
    {
      q: "Can I keep my current DNS and CDN?",
      a: "Yes. Point your domain’s record at Openship and keep your DNS and caching provider in front. Openship issues the certificate for the origin.",
    },
    {
      q: "How does the price stay predictable?",
      a: `Each plan covers the server’s CPU, RAM and storage for the period, shared by all your apps${from ? `, starting at ${from} a month` : ""}. Managed proxy transfer and backups are billed on top, and you can watch usage in your dashboard.`,
    },
    {
      q: "What if I want to leave later?",
      a: "Your apps are plain containers and your services are standard images. Move them to your own servers with the free open-source version of Openship, or anywhere that runs containers.",
    },
    {
      q: "Who helps me if something goes wrong?",
      a: "Every Cloud plan includes email support, and Pro and Scale get priority support. You can also talk to the team before you move.",
    },
  ];
}
