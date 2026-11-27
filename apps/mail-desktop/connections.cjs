const { isIP } = require("node:net");
const { domainToASCII } = require("node:url");

function mailboxAddress(value) {
  const parts = typeof value === "string" ? value.trim().split("@") : [];
  const [local, domain] = parts;
  if (
    parts.length === 2 &&
    /^[^\s@\u0000-\u001f\u007f]{1,64}$/u.test(local) &&
    !/[/:?#%\\\s]/.test(domain)
  ) {
    const ascii = domainToASCII(domain).toLowerCase();
    if (
      local.length + ascii.length < 254 &&
      !isIP(ascii) &&
      ascii.includes(".") &&
      ascii.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    ) {
      return local + "@" + ascii;
    }
  }
  throw new Error("Enter your full mailbox address.");
}

function webOrigin(value, development = false) {
  let url;
  try {
    url = new URL(value);
  } catch {}
  if (
    url &&
    !url.username &&
    !url.password &&
    url.pathname === "/" &&
    !url.search &&
    !url.hash &&
    (url.protocol === "https:" ||
      (development &&
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    return url.origin;
  throw new Error("Enter the HTTPS address where you open OpenShip Mail in a browser.");
}

async function resolveConnection(input, { cloud, development, request = fetch }) {
  const email = mailboxAddress(input?.email);
  if (input.mode === "self")
    return { email, mode: "self", origin: webOrigin(input.url, development) };
  if (input.mode !== "cloud") throw new Error("Choose a hosting option.");
  const url = new URL("/api/mail/discovery", cloud);
  url.searchParams.set("domain", email.split("@")[1]);
  let response;
  try {
    response = await request(url, {
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Could not reach OpenShip Cloud. Check your connection and try again.");
  }
  if (response.status === 404)
    throw new Error(
      "No hosted inbox was found for this domain. If you host OpenShip Mail yourself, choose Self-hosted.",
    );
  if (response.status === 429) throw new Error("Too many lookups. Wait a moment and try again.");
  if (!response.ok) throw new Error("Mailbox discovery is temporarily unavailable. Try again.");
  try {
    const result = await response.json();
    return { email, mode: "cloud", origin: webOrigin(result.webmailUrl, development) };
  } catch {
    throw new Error("Cloud returned an invalid webmail address. Try again later.");
  }
}

module.exports = { mailboxAddress, webOrigin, resolveConnection };
