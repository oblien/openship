import { describe, expect, it } from "vitest";

import { parseRubyVersion, rubyLanguageDetector } from "../src/languages/ruby";

/** A stock Rails 8 lockfile, trimmed to the sections that matter here. */
const LOCKFILE = `GEM
  remote: https://rubygems.org/
  specs:
    actionpack (8.0.1)
      actionview (= 8.0.1)
      rack (>= 2.2.4)
    pg (1.5.9)
    sidekiq (7.3.6)
      redis-client (>= 0.22.2)

PLATFORMS
  ruby

DEPENDENCIES
  rails (~> 8.0)

RUBY VERSION
   ruby 3.3.6p108

BUNDLED WITH
   2.5.23
`;

describe("rubyLanguageDetector", () => {
  it("claims both Gemfile and Gemfile.lock", () => {
    expect(rubyLanguageDetector.manifestFiles).toContain("gemfile");
    expect(rubyLanguageDetector.manifestFiles).toContain("gemfile.lock");
  });

  it("claims .ruby-version so callers fetch it, but reads no deps from it", () => {
    expect(rubyLanguageDetector.manifestFiles).toContain(".ruby-version");
    expect(rubyLanguageDetector.parseManifest(".ruby-version", "3.4.1")).toEqual({});
  });

  it("reads gems from the lockfile that the Gemfile never names", () => {
    const deps = rubyLanguageDetector.parseManifest("Gemfile.lock", LOCKFILE);
    expect(deps.pg).toBe("1.5.9");
    expect(deps.sidekiq).toBe("7.3.6");
    expect(deps.actionpack).toBe("8.0.1");
  });

  it("does NOT treat a spec's own requirements as installed gems", () => {
    // Six-space lines are what that gem requires, not what bundler resolved.
    const deps = rubyLanguageDetector.parseManifest("Gemfile.lock", LOCKFILE);
    expect(deps["redis-client"]).toBeUndefined();
    expect(deps.rack).toBeUndefined();
    expect(deps.actionview).toBeUndefined();
  });

  it("stops at the end of the specs block, so DEPENDENCIES aren't specs", () => {
    // `rails (~> 8.0)` under DEPENDENCIES is a constraint, not a resolution.
    const deps = rubyLanguageDetector.parseManifest("Gemfile.lock", LOCKFILE);
    expect(deps.rails).toBeUndefined();
  });

  it("reads specs from a GIT source as well as the GEM source", () => {
    const deps = rubyLanguageDetector.parseManifest(
      "Gemfile.lock",
      `GIT
  remote: https://github.com/example/vendored.git
  revision: abc123
  specs:
    vendored (0.1.0)

GEM
  remote: https://rubygems.org/
  specs:
    pg (1.5.9)

PLATFORMS
  ruby
`,
    );
    expect(deps.vendored).toBe("0.1.0");
    expect(deps.pg).toBe("1.5.9");
  });

  it("still parses a plain Gemfile, skipping commented gems", () => {
    const deps = rubyLanguageDetector.parseManifest(
      "Gemfile",
      `source "https://rubygems.org"\nruby "3.3.6"\ngem "rails", "~> 8.0"\n# gem "commented"\n`,
    );
    expect(deps.rails).toBe("*");
    expect(deps.commented).toBeUndefined();
  });

  it("returns {} for a filename it does not handle", () => {
    expect(rubyLanguageDetector.parseManifest("Rakefile", "task :default")).toEqual({});
  });
});


describe("parseRubyVersion", () => {
  it.each([
    [".ruby-version", "3.4.1\n", "3.4.1"],
    [".ruby-version", "ruby-3.2.2\r\n", "3.2.2"],
    ["Gemfile.lock", "RUBY VERSION\n   ruby 3.3.6p108\n", "3.3.6"],
    ["Gemfile.lock", "RUBY VERSION\r\n   ruby 3.4.1p0\r\n", "3.4.1"],
    ["Gemfile", `ruby "3.3.0" # production\ngem "rails"`, "3.3.0"],
    ["Gemfile", `ruby '3.4'`, "3.4"],
    ["Gemfile", `ruby("3.4.1")`, "3.4.1"],
    ["Gemfile", `ruby ( "3.4.1" ) # production`, "3.4.1"],
  ])("reads an exact pin from %s: %s", (filename, content, expected) => {
    expect(parseRubyVersion(filename, content)).toBe(expected);
  });

  it.each([
    [".ruby-version", "3.4.1-preview1"], [".ruby-version", "3.4.1.5"],
    [".ruby-version", "3.4.1 && echo wrong"], [".ruby-version", "jruby-9.4.1"],
    [".ruby-version", "3.4.1\n3.3.0"], [".ruby-version", ""],
    ["Gemfile.lock", "RUBY VERSION\n   ruby 3.4.1-preview1\n"],
    ["Gemfile.lock", "RUBY VERSION\n   ruby 3.4.1.5\n"],
    ["Gemfile", `ruby "3.4.1-preview1"`], ["Gemfile", `ruby "3.4.1.5"`],
    ["Gemfile", `ruby "3.4.1#{patch}"`], ["Gemfile", `ruby "3.4.1`],
    ["Gemfile", `ruby "3.4.1'`], ["Gemfile", `ruby "~> 3.4"`],
    ["Gemfile", `ruby ">= 3.4"`], ["Gemfile", `ruby file: ".ruby-version"`],
    ["Gemfile", `# ruby "3.4.1"`],
    ["Gemfile", `ruby "3.1.0", engine: "jruby", engine_version: "9.4.1.0"`],
  ])("does not invent a stable pin from %s: %s", (filename, content) => {
    expect(parseRubyVersion(filename, content)).toBeNull();
  });
});
