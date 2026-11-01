import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { iconAssetUrl, isIconName, outlineModern, resolveIcon, type IconName } from "@repo/ui/icons";

describe("icon catalog", () => {
  it("resolves partial themes and rejects inherited properties or stale runtime IDs", () => {
    const asset = { file: "server.png", mode: "color" } as const;
    const theme = { name: "custom", icons: { server: asset } };
    expect(resolveIcon("server", theme).asset).toBe(asset);
    expect(resolveIcon("mail", theme).asset).toBe(outlineModern.mail);
    for (const name of ["constructor", "__proto__", "removed-icon", "https://icons.example.test/image.png"]) {
      expect(isIconName(name)).toBe(false);
      expect(resolveIcon(name as IconName).id).toBe("help-circle");
    }
  });

  it("switches only the asset prefix and encodes literal filenames consistently", () => {
    const asset = { file: "phone %26 tablet.png", mode: "mask" } as const;
    expect(iconAssetUrl(asset)).toBe("/icons/phone%20%2526%20tablet.png");
    expect(iconAssetUrl(asset, " https://cdn.example.test/icons/// ")).toBe("https://cdn.example.test/icons/phone%20%2526%20tablet.png");
    expect(iconAssetUrl(asset, "")).toBe(iconAssetUrl(asset));
  });

  it("ships every catalog asset as a PNG with no orphan or duplicate copies", () => {
    const directory = resolve(import.meta.dirname, "../../public/icons");
    const files = Object.values(outlineModern).map((asset) => asset.file);
    expect(new Set(files).size).toBe(files.length);
    expect(readdirSync(directory).filter((file) => file.endsWith(".png")).sort()).toEqual([...files].sort());
    const hashes = new Set<string>();
    for (const { file, bounds, inset } of Object.values(outlineModern)) {
      const png = readFileSync(resolve(directory, file));
      expect(png.subarray(0, 8).toString("hex"), file).toBe("89504e470d0a1a0a");
      // Keep source resolutions intact; bounds normalize each square canvas.
      const imageWidth = png.readUInt32BE(16);
      expect(imageWidth, file).toBeGreaterThan(0);
      expect(png.readUInt32BE(20), file).toBe(imageWidth);
      expect(bounds, `Missing visible bounds: ${file}`).toHaveLength(4);
      const [x, y, width, height] = bounds!;
      expect(x, file).toBeGreaterThanOrEqual(0);
      expect(y, file).toBeGreaterThanOrEqual(0);
      expect(width, file).toBeGreaterThan(0);
      expect(height, file).toBeGreaterThan(0);
      expect(x + width, file).toBeLessThanOrEqual(24);
      expect(y + height, file).toBeLessThanOrEqual(24);
      expect(Number.isFinite(inset ?? 1), file).toBe(true);
      expect(inset ?? 1, file).toBeGreaterThanOrEqual(0);
      expect(inset ?? 1, file).toBeLessThan(12);
      const hash = createHash("sha256").update(png).digest("hex");
      expect(hashes.has(hash), `Duplicate artwork: ${file}`).toBe(false);
      hashes.add(hash);
    }
  });

  it("keeps dashboard UI icons on the shared renderer", () => {
    const sourceDirectory = resolve(import.meta.dirname, "..");
    for (const relative of readdirSync(sourceDirectory, { recursive: true })) {
      const file = String(relative);
      if (!/\.[jt]sx?$/.test(file) || file.includes(".test.")) continue;
      const source = readFileSync(resolve(sourceDirectory, file), "utf8");
      expect(source, file).not.toMatch(/from\s+["'](?:lucide-react|@\/utils\/icons)["']/);
      expect(source, file).not.toMatch(/(?:cdn\.oblien\.com\/static\/png-icons|monokai_pro_icons)/);
    }
  });
});
