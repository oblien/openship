import "@testing-library/jest-dom/vitest";

import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// With test.globals disabled, React Testing Library's automatic
// afterEach-cleanup registration never runs (it hooks into the injected
// global afterEach). Register it explicitly so component trees rendered in
// one test don't leak into the next.
afterEach(() => {
  cleanup();
});
