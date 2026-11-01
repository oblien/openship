import { describe, expect, it } from "bun:test";
import { getReplyDefaults } from "./reply-defaults";

const message = {
  sender: { email: "sender@example.com" },
  to: [{ email: "me@example.com" }, { email: "teammate@example.com" }],
  cc: [{ email: "copy@example.com" }, { email: "ME@example.com" }],
  subject: "Project update",
};

describe("getReplyDefaults", () => {
  it("addresses a reply to the sender and preserves a reply subject", () => {
    expect(getReplyDefaults(message, "reply", ["me@example.com"])).toEqual({
      to: ["sender@example.com"],
      cc: [],
      subject: "Re: Project update",
    });
  });

  it("addresses reply-all without the current user or duplicate recipients", () => {
    expect(getReplyDefaults(message, "replyAll", ["me@example.com"])).toEqual({
      to: ["sender@example.com", "teammate@example.com"],
      cc: ["copy@example.com"],
      subject: "Re: Project update",
    });
  });

  it("replies to an external recipient when the original sender is the current user", () => {
    expect(
      getReplyDefaults({ ...message, sender: { email: "me@example.com" } }, "reply", [
        "me@example.com",
      ]),
    ).toMatchObject({ to: ["teammate@example.com"] });
  });

  it("does not duplicate an existing subject prefix", () => {
    expect(
      getReplyDefaults({ ...message, subject: "Re: Project update" }, "reply", ["me@example.com"])
        .subject,
    ).toBe("Re: Project update");
  });

  it("excludes aliases and deduplicates recipients across To and Cc", () => {
    expect(getReplyDefaults({
      ...message,
      to: [...message.to, { email: "SENDER@example.com" }, { email: "alias@example.com" }],
      cc: [...message.cc, { email: "TEAMMATE@example.com" }, { email: "COPY@example.com" }],
    }, "replyAll", ["me@example.com", "ALIAS@example.com"])).toEqual({
      to: ["sender@example.com", "teammate@example.com"],
      cc: ["copy@example.com"],
      subject: "Re: Project update",
    });
  });

  it("keeps forwarding recipients empty and preserves an existing prefix", () => {
    expect(getReplyDefaults({ ...message, subject: "Fwd: Project update" }, "forward", []))
      .toEqual({ to: [], cc: [], subject: "Fwd: Project update" });
  });
});
