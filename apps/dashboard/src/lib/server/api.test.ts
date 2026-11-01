import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { RequestCookies, ResponseCookies } from "next/dist/compiled/@edge-runtime/cookies";

const h = vi.hoisted(() => ({ headers: new Headers(), getAll: vi.fn(), set: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => h.headers,
  cookies: async () => ({ getAll: h.getAll, set: h.set }),
}));
import { serverApi } from "./api";

let responseCookies: string[] = [];
let browserHeaders: Headers;
const server = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (responseCookies.length) res.setHeader("set-cookie", responseCookies);
  const cookie = req.headers.cookie ?? "";
  res.end(
    JSON.stringify({
      raw: cookie,
      values: Object.fromEntries(
        new RequestCookies(new Headers({ cookie })).getAll().map((c) => [c.name, c.value]),
      ),
    }),
  );
});
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
});
beforeEach(() => {
  vi.clearAllMocks();
  responseCookies = [];
  browserHeaders = new Headers();
  const response = new ResponseCookies(browserHeaders);
  h.set.mockImplementation((...args: Parameters<ResponseCookies["set"]>) => response.set(...args));
  vi.stubEnv(
    "OPENSHIP_LOCAL_API_URL",
    `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  );
});
function incoming(raw: string) {
  h.headers = new Headers({ cookie: raw });
  const jar = new RequestCookies(h.headers);
  h.getAll.mockImplementation(() => jar.getAll());
}

it("forwards decoded cookies safely over HTTP without changing session or unrelated values", async () => {
  const values = {
    "openship.session_token": "session+/=signed%value",
    other_app: "的",
    latin: "é",
    punctuation: "value; forged=admin\r\nextra: header",
    theme: "dark",
  };
  incoming(
    Object.entries(values)
      .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
      .join("; "),
  );
  const result = await serverApi.get<{ values: Record<string, string>; raw: string }>("test");
  expect(result.values).toEqual(values);
  expect(result.raw).not.toMatch(/[^\x20-\x7e]/);
});

it("round-trips refreshed session cookies through Next without double encoding", async () => {
  incoming("theme=dark");
  responseCookies = [
    "openship.session_token=s%3Aabc%2B%2F%3D%252F; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600",
    "display=%E7%9A%84; Path=/",
  ];
  await serverApi.get("test");
  const session = browserHeaders
    .getSetCookie()
    .find((value) => value.startsWith("openship.session_token="))!;
  expect(session.split(";")[0]).toBe("openship.session_token=s%3Aabc%2B%2F%3D%252F");
  expect(session).toContain("HttpOnly");
  expect(session).toContain("Secure");
  expect(session).toContain("SameSite=lax");
  expect(session).toContain("Max-Age=3600");
  incoming(
    browserHeaders
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; "),
  );
  responseCookies = [];
  const result = await serverApi.get<{ values: Record<string, string> }>("test");
  expect(result.values).toEqual({ "openship.session_token": "s:abc+/=%2F", display: "的" });
});

it("skips a malformed encoded response cookie without losing a later valid session cookie", async () => {
  incoming("");
  responseCookies = ["bad=%E0%A4%A; Path=/", "openship.session_token=valid%2Bsignature; Path=/"];
  await serverApi.get("test");
  const jar = new RequestCookies(
    new Headers({
      cookie: browserHeaders
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; "),
    }),
  );
  expect(jar.get("openship.session_token")?.value).toBe("valid+signature");
  expect(jar.get("bad")).toBeUndefined();
});
