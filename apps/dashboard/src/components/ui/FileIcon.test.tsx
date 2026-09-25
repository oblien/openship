import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import FileIcon, { fileIconName } from "./FileIcon";

describe("file icons", () => {
  it.each([
    ["src/App.tsx", undefined, "file-code"],
    ["config/settings.yaml", undefined, "file-code"],
    ["README.MD", undefined, "file-text"],
    ["public/photo.PNG", undefined, "file-image"],
    ["backups/data.tar.gz", undefined, "file-archive"],
    ["services/api/Dockerfile", undefined, "docker"],
    ["C:\\project\\Dockerfile.production", undefined, "docker"],
    ["bin/start", "shellscript", "file-code"],
    ["NOTICE", "plaintext", "file-text"],
    ["unknown.data", undefined, "file"],
    ["", undefined, "file"],
  ])("classifies %s without a separate font or icon theme", (fileName, language, expected) => {
    expect(fileIconName(fileName, language)).toBe(expected);
  });

  it("renders an unknown file visibly and lets the caller override its color", () => {
    const html = renderToStaticMarkup(<FileIcon fileName="unknown" style={{ color: "var(--primary)" }} />);
    expect(html).toContain('data-icon="file"');
    expect(html).toContain('width="16"');
    expect(html).toContain("color:var(--primary)");
    expect(html).not.toContain("font-family");
  });
});
