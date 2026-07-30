import { NextResponse } from "next/server";

// TODO: removed — temporary Cloud-waitlist forwarder for the SaaS deploy gate.
// Delete when Openship Cloud launches (along with CloudWaitlistModal + the gate).

/**
 * Cloud "notify me" waitlist submit. Forwards the email to the external
 * marketing API (`process.env.MARKETING_API_URL`) — server-side, so the URL
 * stays off the client and there's no CORS. When the env isn't set (dev /
 * self-hosted), it accepts silently so the UI still confirms.
 *
 * Not the Hono backend and not the DB — a thin fire-and-forward to marketing.
 */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function POST(req: Request) {
  let email = "";
  try {
    const body = (await req.json()) as { email?: unknown };
    email = typeof body?.email === "string" ? body.email.trim() : "";
  } catch {
    /* malformed body → falls through to the validation error below */
  }

  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }

  const url = process.env.MARKETING_API_URL;
  if (!url) {
    // Not configured (dev / self-hosted) — accept so the UX still confirms.
    return NextResponse.json({ ok: true, forwarded: false });
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, source: "cloud-deploy-waitlist" }),
    });
    if (!res.ok) {
      return NextResponse.json({ error: "Couldn't reach the waitlist. Try again." }, { status: 502 });
    }
    return NextResponse.json({ ok: true, forwarded: true });
  } catch {
    return NextResponse.json({ error: "Couldn't reach the waitlist. Try again." }, { status: 502 });
  }
}
