import { expect, it, vi } from "vitest";
import { OpenshipClient } from "../src/client";

it("uses shared affiliate routes and rejects client-supplied beneficiary fields", async () => {
  const request = vi.fn(async (_url: string, _init?: RequestInit) =>
    Response.json({ data: { items: [], total: 0 } }),
  );
  const client = new OpenshipClient({
    baseUrl: "https://ship.example.test",
    token: "personal",
    fetch: request,
  });
  await expect(client.affiliates.referrals({ limit: 10, offset: 20 })).resolves.toEqual({
    items: [],
    total: 0,
  });
  expect(request.mock.calls[0]?.[0]).toBe(
    "https://ship.example.test/api/affiliates/referrals?limit=10&offset=20",
  );
  await expect(
    client.affiliates.requestPayout({
      amountCents: 5000,
      idempotencyKey: "same-payout-request",
      participantKey: "other",
    } as never),
  ).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(1);
});
it("submits a cash payout request without exposing any operator action", async () => {
  const id = "a9f5dc30-d050-4435-b729-c8f7218b3e5b";
  const request = vi.fn(async (_url: string, _init?: RequestInit) =>
    Response.json({
      data: {
        id,
        amountCents: 5000,
        currency: "usd",
        status: "pending",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    }),
  );
  const client = new OpenshipClient({ baseUrl: "https://ship.example.test", fetch: request });
  await client.affiliates.requestPayout({
    amountCents: 5000,
    idempotencyKey: "same-payout-request",
  });
  expect(request.mock.calls[0]?.[0]).toBe("https://ship.example.test/api/affiliates/payouts");
  expect(JSON.parse((request.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({
    amountCents: 5000,
    idempotencyKey: "same-payout-request",
  });
  expect(client.affiliates).not.toHaveProperty("approve");
  expect(client.affiliates).not.toHaveProperty("configure");
});
