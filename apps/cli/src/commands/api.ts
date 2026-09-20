import { Command } from "commander";
import { getRemoteClient } from "../lib/ship-client";
import { err, printJson } from "../lib/output";

/**
 * `gh api`-style escape hatch: authenticated raw access to any API route.
 * This is what lets the CLI stay small — anything not worth a dedicated
 * command (audit log, image catalog, one-off reads) is reachable here.
 */
export const apiCommand = new Command("api")
  .description("Make an authenticated request to any Openship API route (like `gh api`)")
  .argument("<path>", "Path under /api, e.g. /projects or /deployments/<id>")
  .option("-X, --method <method>", "HTTP method (defaults to GET, or POST when --data is given)")
  .option("-d, --data <json>", "Request body as a JSON string")
  .option("-q, --query <kv...>", "Query parameter key=value (repeatable)")
  .action(async (path: string, opts) => {
    const method = (opts.method || (opts.data ? "POST" : "GET")).toUpperCase();
    let url = path.startsWith("/") ? path : `/${path}`;
    if (opts.query?.length) {
      const sp = new URLSearchParams();
      for (const kv of opts.query as string[]) {
        const i = kv.indexOf("=");
        if (i > 0) sp.set(kv.slice(0, i), kv.slice(i + 1));
      }
      url += (url.includes("?") ? "&" : "?") + sp.toString();
    }

    const init: RequestInit = { method };
    if (opts.data) init.body = opts.data;

    try {
      const res = await getRemoteClient().http.raw(url, init);
      const text = await res.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // non-JSON response — print raw
      }
      if (typeof body === "string") {
        if (body) process.stdout.write(body.endsWith("\n") ? body : body + "\n");
      } else {
        printJson(body);
      }
      if (!res.ok) process.exitCode = 1;
    } catch (e) {
      err(`  ${(e as Error).message}`);
      process.exit(1);
    }
  });
