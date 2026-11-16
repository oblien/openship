import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Route tests now exercise durable state. Never open a developer's real mailbox database.
const directory = mkdtempSync(join(tmpdir(), "openship-mail-test-"));
process.env.NODE_ENV = "test";
process.env.SQLITE_PATH = join(directory, "mail.db");
process.env.SESSION_ENCRYPTION_KEY = "0123456789abcdef".repeat(4);
process.env.BRANDING_ADMIN_TOKEN = "mail-test-branding-token";
process.env.BRANDING_PATH = join(directory, "branding");
process.env.MAIL_MINDWIRE_TARGETS = "{}";
process.on("exit", () => rmSync(directory, { recursive: true, force: true }));
