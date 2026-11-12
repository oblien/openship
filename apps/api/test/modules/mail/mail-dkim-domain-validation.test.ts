import "./_setup-env";
import { expect, it, vi } from "vitest";
import { provisionDomainDkim } from "@repo/platform/engine/modules/mail/mail.service";

it.each(["x;touch /tmp/executed.test", "../example.test", "x'example.test", "x$(id).test"])(
  "refuses unsafe restored domain %s before filesystem or shell access",
  async (domain) => {
    const exec = vi.fn();
    await expect(provisionDomainDkim({ exec } as never, domain)).rejects.toThrow("Invalid domain");
    expect(exec).not.toHaveBeenCalled();
  },
);
