import { describe, expect, it } from "vitest";
import { SecretValues, secretValueLiterals } from "./secret-values";

describe("known secret output filtering", () => {
  const values = [
    "short",
    "shorter",
    "abcXYZ",
    "XYZdef",
    "q'uote-$()",
    '{"private_key":"line1\\nline2"}',
    "multi\nline-value",
    "🔐credential",
  ];

  it("masks raw, JSON and shell representations without interpreting regex syntax", () => {
    const filter = new SecretValues(values);
    for (const literal of secretValueLiterals(values))
      expect(filter.redact(`before ${literal} after`)).toBe("before *** after");
    expect(filter.redact("ordinary build progress")).toBe("ordinary build progress");
    expect(new SecretValues(["a", "abc"]).redact("abc")).toBe("***");
    expect(filter.redact("abcXYZdef")).toBe("***");
  });

  it("handles every chunk boundary, including overlapping values and multi-line JSON", () => {
    const filter = new SecretValues(values);
    const text = `begin ${values.join(" | ")} abcXYZdef done\0`;
    for (let split = 0; split <= text.length; split++) {
      const stream = filter.stream();
      expect(
        stream.write(text.slice(0, split)) + stream.write(text.slice(split)) + stream.end(),
      ).toBe(filter.redact(text));
    }
    const stream = filter.stream();
    expect([...text].map((char) => stream.write(char)).join("") + stream.end()).toBe(
      filter.redact(text),
    );
  });

  it("withholds incomplete values and masks them when a process stops", () => {
    const stream = new SecretValues(["credential-value"]).stream();
    expect(stream.write("progress: credent")).toBe("progress: ");
    expect(stream.end()).toBe("***");
    expect(stream.end()).toBe("");
  });

  it("does not share partial values across streams or deployments", () => {
    const secrets = new SecretValues(["credential-value"]);
    const a = secrets.stream();
    const b = secrets.stream();
    expect(a.write("credent")).toBe("");
    expect(b.write("other output\n")).toBe("other output\n");
    expect(a.write("ial-value\n")).toBe("***\n");
    expect(new SecretValues([]).redact("credential-value")).toBe("credential-value");
  });

  it("keeps overlapping repeated secrets bounded and never reveals a covered suffix", () => {
    const stream = new SecretValues(["aaaa"]).stream();
    expect(stream.write("a".repeat(16_000))).toBe("***");
    for (let i = 0; i < 100; i++) expect(stream.write("aaaa")).toBe("");
    expect(stream.write("x")).toBe("x");
    expect(stream.end()).toBe("");
    const overlapping = new SecretValues(["abcabc", "abcabcdef"]).stream();
    expect(overlapping.write("abcabc")).toBe("");
    expect(overlapping.write("X")).toBe("***X");
  });

  it("bounds scanning for long repeated prefixes", () => {
    const value = "a".repeat(16_000) + "b";
    const stream = new SecretValues([value]).stream();
    const text = "a".repeat(250_000) + "b\0";
    expect(stream.write(text) + stream.end()).toBe("a".repeat(234_000) + "***\0");
  });

  it("handles long credentials one byte at a time without rescanning retained prefixes", () => {
    const value = "a".repeat(64_000) + "b";
    const stream = new SecretValues([value]).stream();
    for (const char of value.slice(0, -1)) expect(stream.write(char)).toBe("");
    expect(stream.write("b\n") + stream.end()).toBe("***\n");
  });

  it("matches an independent literal-coverage oracle across overlapping values and arbitrary chunks", () => {
    let seed = 1663;
    const random = (max: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % max;
    };
    const word = (length: number) => Array.from({ length }, () => "abc"[random(3)]).join("");
    for (let sample = 0; sample < 500; sample++) {
      const values = Array.from({ length: 5 }, () => word(2 + random(10)));
      const text = word(40) + values.join(" ") + word(40) + "\0";
      const covered = Array<boolean>(text.length).fill(false);
      for (const value of values) {
        for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + 1))
          covered.fill(true, at, at + value.length);
      }
      const expected = [...text].map((char, i) => covered[i] ? (covered[i - 1] ? "" : "***") : char).join("");
      const filter = new SecretValues(values);
      const stream = filter.stream();
      let actual = "";
      for (let i = 0; i < text.length;) {
        const end = i + 1 + random(7);
        actual += stream.write(text.slice(i, end));
        i = end;
      }
      actual += stream.end();
      const coalesce = (value: string) => value.replace(/(?:\*\*\*)+/g, "***");
      expect(coalesce(filter.redact(text))).toBe(expected);
      expect(coalesce(actual)).toBe(expected);
    }
  });
});
