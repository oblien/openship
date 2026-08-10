/**
 * What an operator actually reads at the top of an alert.
 *
 * A category is a SUBSCRIPTION, and two of them deliberately carry an event and its
 * own opposite so nobody can subscribe to the bad news only. Rendering the message
 * from the category alone therefore titled a server RECOVERY "Server unreachable",
 * and opened its body with "We can't reach a server's Docker daemon" — one line above
 * "is answering again after 4m 12s". On a phone the subject line is the whole alert,
 * so that reads as a fresh outage.
 */
import { describe, expect, it } from "vitest";
import type { NotificationDelivery } from "@repo/db";

import { renderMessage } from "../../src/lib/notification-workers";

/** The two fields renderMessage reads. The rest of the row is irrelevant here. */
const delivery = (category: string, payload: Record<string, unknown>) =>
  ({ category, payload }) as unknown as NotificationDelivery;

describe("delivered headline vs the category it was subscribed through", () => {
  it("titles a server recovery for what happened, not for the toggle it rode in on", () => {
    const msg = renderMessage(
      delivery("server.unreachable", {
        eventType: "server.reachable",
        message: 'Server "web-1" is answering again after 4m 12s.',
      }),
    );

    expect(msg.title).toBe("Server reachable");
    expect(msg.body).toContain("answering again");
    // The body must not open by asserting the opposite of its own next line.
    expect(msg.body).not.toMatch(/can't reach/i);
  });

  it("leaves the outage alert's own blunt headline alone", () => {
    // The half that must not regress: this is the message somebody is woken by, and
    // the title is the only part a lock screen shows.
    const msg = renderMessage(
      delivery("server.unreachable", {
        eventType: "server.unreachable",
        message: 'Can\'t reach Docker on server "web-1": connect ETIMEDOUT 10.0.0.9:22.',
      }),
    );

    expect(msg.title).toBe("Server unreachable");
    expect(msg.body).toMatch(/can't reach a server's Docker daemon/i);
  });

  it("uses the category for every event type without an override", () => {
    const msg = renderMessage(
      delivery("service.down", { eventType: "service.down", message: "it exited with code 1" }),
    );
    expect(msg.title).toBe("App down");
  });

  it("still names a delivery whose payload carries no eventType", () => {
    // Queued rows outlive a deploy, and the payload is free-form JSON: a missing
    // eventType has to fall back to the category, not render "undefined".
    const msg = renderMessage(delivery("service.recovered", { message: "back up" }));
    expect(msg.title).toBe("App recovered");
  });
});
