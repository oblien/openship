import { parseDockerfile } from "@repo/adapters";
import { ValidationError, validateImageReference } from "@repo/core";
import { isMap, isScalar, parseDocument } from "yaml";
import type { RuntimeSource } from "@repo/contracts";

type Reference = RuntimeSource["references"][number] & {
  start: number;
  end: number;
  quoted?: boolean;
};
// Reuse deployment reference validation; scratch is a build stage, not a registry image.
const isSourceImage = (image: string) =>
  image.length <= 512 && image !== "scratch" && validateImageReference(image) === null;
export function assertRuntimeSourceImage(image: string) {
  if (!isSourceImage(image))
    throw new ValidationError("Enter a literal container image reference.");
}

/** Locate a single literal without serializing/reformatting the user's source. */
export function inspectRuntimeSource(
  content: string,
  format: "dockerfile" | "compose",
  serviceName?: string,
) {
  if (Buffer.byteLength(content) > 64000 || content.includes("\0"))
    throw new ValidationError("Choose a source file smaller than 64 KB.");
  const references: Reference[] = [];
  const guidance: string[] = [];
  const add = (ref: Reference) => {
    if (isSourceImage(ref.image)) references.push(ref);
    else guidance.push(`${ref.label}: edit the variable or image expression in the repository.`);
  };
  if (format === "dockerfile") {
    // The shared parser identifies instructions. These constructs need an editor
    // that understands their evaluation context; never guess at their source ranges.
    if (
      /\\\r?\n|<<|^\s*#\s*escape\s*=/im.test(content) ||
      /^\s*#\s*syntax\s*=\s*(?!(?:docker\.io\/)?docker\/dockerfile(?::|@|\s|$))/im.test(content)
    ) {
      return {
        references,
        guidance: [
          "Edit this Dockerfile in the repository; it uses a custom frontend, heredoc or line continuation.",
        ],
      };
    }
    const lines = content.split("\n");
    const offsets: number[] = [];
    let offset = 0;
    for (const line of lines) {
      offsets.push(offset);
      offset += line.length + 1;
    }
    const stages = new Set<string>();
    for (const instruction of parseDockerfile(content).instructions) {
      if (instruction.keyword !== "FROM") continue;
      const parts = instruction.value.match(/^(\S+)(?:\s+AS\s+([\w.-]+))?\s*$/i);
      const line = lines[instruction.line - 1]!;
      const match = line.match(/^[ \t]*FROM[ \t]+(?:--platform=\S+[ \t]+)?(\S+)/i);
      if (!parts || !match || parts[1] !== match[1]) {
        guidance.push(`Line ${instruction.line}: edit this FROM instruction in the repository.`);
        continue;
      }
      const [, image, stage] = parts;
      if (image!.toLowerCase() !== "scratch" && !stages.has(image!.toLowerCase())) {
        const start = offsets[instruction.line - 1]! + match[0].length - image!.length;
        add({
          id: `from:${instruction.line}`,
          label: stage ? `FROM · ${stage}` : `FROM · line ${instruction.line}`,
          image: image!,
          line: instruction.line,
          start,
          end: start + image!.length,
        });
      }
      if (stage) stages.add(stage.toLowerCase());
    }
  } else {
    const doc = parseDocument(content, { customTags: [], uniqueKeys: true });
    if (doc.errors.length)
      throw new ValidationError("Fix the Compose YAML errors before proposing an image update.");
    const services = doc.get("services", true);
    if (!isMap(services)) throw new ValidationError("This file has no Compose services mapping.");
    for (const item of services.items) {
      if (!isScalar(item.key) || typeof item.key.value !== "string") continue;
      const name = item.key.value;
      if (serviceName && name !== serviceName) continue;
      if (
        !isMap(item.value) ||
        services.anchor ||
        item.value.anchor ||
        item.value.tag ||
        item.value.has("<<") ||
        item.value.has("extends")
      ) {
        guidance.push(`${name}: edit the inherited service in the repository.`);
        continue;
      }
      if (item.value.has("build")) {
        guidance.push(
          `${name}: select its Dockerfile to change the base image. The Compose image field names its build output.`,
        );
        continue;
      }
      const value = item.value.get("image", true);
      if (
        !isScalar(value) ||
        typeof value.value !== "string" ||
        !value.range ||
        value.anchor ||
        value.tag ||
        !["PLAIN", "QUOTE_DOUBLE", "QUOTE_SINGLE"].includes(value.type ?? "")
      ) {
        guidance.push(`${name}: edit the image or inherited configuration in the repository.`);
        continue;
      }
      const [start, end] = value.range;
      add({
        id: `service:${name}`,
        label: name,
        image: value.value,
        line: content.slice(0, start).split("\n").length,
        start,
        end,
        quoted: value.type !== "PLAIN",
      });
    }
  }
  return { references, guidance };
}

export function replaceRuntimeSourceImage(
  content: string,
  format: "dockerfile" | "compose",
  referenceId: string,
  image: string,
  serviceName?: string,
) {
  assertRuntimeSourceImage(image);
  const { references } = inspectRuntimeSource(content, format, serviceName);
  const ref = references.find((item) => item.id === referenceId);
  if (!ref)
    throw new ValidationError("Select a supported image reference from this source revision.");
  if (ref.image === image) throw new ValidationError("Choose a different image reference.");
  const scalar = format === "compose" ? parseDocument(image) : null;
  const needsQuotes =
    scalar &&
    (scalar.errors.length > 0 ||
      !isScalar(scalar.contents) ||
      typeof scalar.contents.value !== "string");
  const replacement = ref.quoted
    ? `${content[ref.start]}${image}${content[ref.start]}`
    : needsQuotes
      ? JSON.stringify(image)
      : image;
  const after = content.slice(0, ref.start) + replacement + content.slice(ref.end);
  if (
    inspectRuntimeSource(after, format, serviceName).references.find(
      (item) => item.id === referenceId,
    )?.image !== image
  )
    throw new ValidationError(
      "The replacement must remain an external image reference, not a build stage.",
    );
  return after;
}
