import { renderToStaticMarkup } from "react-dom/server";
import { CountryFlag } from "@/components/monitoring/CountryFlag";
const html = renderToStaticMarkup(<CountryFlag code="US" title="United States" />);
console.log(html.slice(0, 260));
import { it, expect } from "vitest";
it("probe", () => { expect(html.length).toBeGreaterThan(0); });
