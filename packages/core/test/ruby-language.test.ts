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
  it("reads the RUBY VERSION stanza from a lockfile, dropping the patch suffix", () => {
    expect(parseRubyVersion("Gemfile.lock", LOCKFILE)).toBe("3.3.6");
  });

  it("reads a bare .ruby-version file", () => {
    expect(parseRubyVersion(".ruby-version", "3.4.1\n")).toBe("3.4.1");
  });

  it("strips the `ruby-` prefix some version managers write", () => {
    expect(parseRubyVersion(".ruby-version", "ruby-3.2.2\n")).toBe("3.2.2");
  });

  it("reads the ruby directive from a Gemfile", () => {
    expect(parseRubyVersion("Gemfile", `source "x"\nruby "3.3.0"\ngem "rails"\n`)).toBe("3.3.0");
  });

  it("ignores `ruby file:` — that names a file, not a version", () => {
    expect(parseRubyVersion("Gemfile", `ruby file: ".ruby-version"\ngem "rails"\n`)).toBeNull();
  });

  it("ignores a constraint like `ruby \"~> 3.3\"` — not a pin", () => {
    expect(parseRubyVersion("Gemfile", `ruby "~> 3.3"\n`)).toBeNull();
  });

  it("returns null when there is no version to find", () => {
    expect(parseRubyVersion("Gemfile", `gem "rails"\n`)).toBeNull();
    expect(parseRubyVersion(".ruby-version", "  \n")).toBeNull();
    expect(parseRubyVersion("Gemfile.lock", "GEM\n  specs:\n    pg (1.5.9)\n")).toBeNull();
  });
});
