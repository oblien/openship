import { seedSampleMail } from "./seed";

// This entrypoint is used only by dev/compose.yml. Production imports main.ts directly.
await seedSampleMail();
const { default: server } = await import("../server/src/main");
export default server;
