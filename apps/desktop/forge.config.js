// @ts-check
const { execFileSync } = require("node:child_process");
const { chmodSync, existsSync, renameSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const ICON_BASE = path.join(__dirname, "assets/icon"); // packager appends .icns/.ico
const RESOURCES = path.join(__dirname, "resources");

// Code signing is opt-in: wire osxSign only when the Developer ID identity is
// present (CI secret APPLE_IDENTITY). Unset → an unsigned build.
//
// NOTE: notarization + stapling are NOT done here — they run in the release
// workflow against the finished .dmg (release.yml). Notarizing per-.app would
// double the notary round-trips and can't staple the .dmg the user downloads.
const APPLE_IDENTITY = process.env.APPLE_IDENTITY;
const osxSigning = APPLE_IDENTITY
  ? {
      osxSign: {
        identity: APPLE_IDENTITY,
        // Hardened runtime + entitlements are REQUIRED for notarization, and the
        // same entitlements must apply to every nested Mach-O (the compiled
        // openship-api binary, any native .node addons in the dashboard bundle)
        // via optionsForFile — the app spawns/loads them, so they all need
        // allow-jit / disable-library-validation or the hardened app crashes.
        optionsForFile: () => ({
          hardenedRuntime: true,
          entitlements: path.join(__dirname, "entitlements.plist"),
        }),
      },
    }
  : {};

module.exports = {
  packagerConfig: {
    name: "Openship",
    executableName: "openship",
    // Stable, owned bundle identifier — used by the code signature, notarization,
    // Keychain, and LaunchServices. Without it packager defaults to the generic
    // `com.electron.openship`, which collides with other Electron apps.
    appBundleId: "com.oblien.openship",
    icon: ICON_BASE,
    asar: true,
    // The main/preload are bundled (build/bundle.mjs) into self-contained files,
    // so the app has no runtime node_modules. Skip the dependency prune (which
    // flora-colossus can't walk against bun's store layout) and ship only the
    // bundled `out/` + package.json. The API + dashboard ride along via
    // extraResource below.
    prune: false,
    ignore: (p) => {
      if (!p) return false; // keep the app root
      const rel = p.startsWith("/") ? p.slice(1) : p;
      // Ship only the bundled app (dist/) + its manifest. `out/` is forge's own
      // output dir and is excluded by packager automatically.
      return !(rel === "package.json" || rel === "dist" || rel.startsWith("dist/"));
    },
    // Bundled payload built by build/stage.ts. These are the ONLY things that
    // make the app self-contained; no source is copied.
    extraResource: [
      path.join(RESOURCES, "bin"),
      path.join(RESOURCES, "dashboard"),
      path.join(RESOURCES, "migrations"),
      path.join(RESOURCES, "pglite"),
      // ssh2 + dockerode (externalized from the --compile binary) — resolved at
      // runtime via NODE_PATH=<Resources>/node_modules in services.ts.
      path.join(RESOURCES, "node_modules"),
    ],
    ...osxSigning,
  },

  hooks: {
    // Build + stage the self-contained payload (API binary, dashboard
    // standalone, migrations, pglite assets) before packaging. Runs for both
    // `package` and `make`. Requires bun on PATH.
    generateAssets: async (_forgeConfig, _platform, arch) => {
      // Forward the build arch so stage.ts compiles the API for the right
      // target (enables cross-compiling x64 on an arm64 runner).
      execFileSync("bun", ["run", path.join(__dirname, "build/stage.ts")], {
        cwd: __dirname,
        stdio: "inherit",
        env: { ...process.env, FORGE_ARCH: arch },
      });
    },

    // The compiled API's exec bit is set in build/stage.ts BEFORE packaging so
    // osxSign seals a correct bundle — we must NEVER chmod inside a signed .app
    // here (that broke the signature and produced the "damaged" Gatekeeper
    // error). This only re-asserts it for Linux, which ships unsigned.
    postPackage: async (_forgeConfig, options) => {
      if (process.platform !== "linux") return;
      for (const out of options.outputPaths) {
        const p = path.join(out, "resources/bin/openship-api");
        if (existsSync(p)) chmodSync(p, 0o755);

        // When unprivileged userns is blocked, Electron's sandbox falls back to
        // its SUID helper, which can't run from a nosuid AppImage mount, the
        // app aborts at launch. 
        // This makes wrapper adds --no-sandbox only in these cases
        const exe = path.join(out, "openship");
        if (existsSync(exe)) {
          renameSync(exe, path.join(out, "openship.bin"));
          writeFileSync(
            exe,
            [
              "#!/bin/sh",
              '# $0 is a bare word when invoked via PATH; resolve it before readlink.',
              'self="$0"',
              'case "$self" in */*) ;; *) self="$(command -v -- "$self")" || self="$0";; esac',
              'dir="$(dirname "$(readlink -f "$self")")"',
              'if { [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = "1" ] &&',
              '     [ "$(cat /sys/module/apparmor/parameters/enabled 2>/dev/null)" = "Y" ]; } ||',
              '   [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null)" = "0" ] ||',
              '   [ "$(cat /proc/sys/user/max_user_namespaces 2>/dev/null)" = "0" ]; then',
              '  set -- --no-sandbox "$@"',
              "fi",
              'exec "$dir/openship.bin" "$@"',
              "",
            ].join("\n"),
          );
          chmodSync(exe, 0o755);
        }
      }
    },

    // Build the macOS .dmg with hdiutil instead of @electron-forge/maker-dmg.
    // maker-dmg pulls in appdmg -> macos-alias, a native (node-gyp) module bun
    // doesn't build on CI's cold cache, which broke the dmg step. hdiutil ships
    // with macOS and needs no node deps. Output lands in out/make/ so the
    // release workflow's `find -name *.dmg` still picks it up.
    postMake: async (_forgeConfig, makeResults) => {
      if (process.platform !== "darwin") return makeResults;
      // Forge builds one arch per `make` invocation; take it from the results
      // so a cross-built x64 make produces Openship-x64.dmg (not the host arch).
      const arch = makeResults.find((r) => r.platform === "darwin")?.arch || process.arch;
      const appPath = path.join(__dirname, "out", `Openship-darwin-${arch}`, "Openship.app");
      if (!existsSync(appPath)) {
        throw new Error(`postMake: expected packaged app at ${appPath}`);
      }
      const dmgPath = path.join(__dirname, "out", "make", `Openship-${arch}.dmg`);
      const staging = path.join(__dirname, "out", `dmg-staging-${arch}`);
      execFileSync("rm", ["-rf", staging, dmgPath]);
      execFileSync("mkdir", ["-p", staging]);
      // `ditto` (not `cp -R`) preserves the code signature, symlinks, and
      // extended attributes of the signed .app bundle. `cp -R` can drop xattrs
      // and mangle framework symlinks, invalidating the signature.
      execFileSync("ditto", [appPath, path.join(staging, "Openship.app")]);
      execFileSync("ln", ["-s", "/Applications", path.join(staging, "Applications")]);
      // hdiutil intermittently fails with "Resource busy" on CI macOS runners:
      // Spotlight/APFS grabs the just-`ditto`'d staging folder as hdiutil tries
      // to snapshot it, or a stale /Volumes/Openship mount lingers from a prior
      // attempt. Detach any leftover volume and retry with a short backoff so
      // the transient contention clears instead of failing the release.
      const detachStale = () => {
        try {
          execFileSync("hdiutil", ["detach", "-force", "/Volumes/Openship"], { stdio: "ignore" });
        } catch {
          /* nothing mounted — fine */
        }
      };
      let hdiutilErr;
      for (let attempt = 1; attempt <= 5; attempt++) {
        detachStale();
        try {
          execFileSync(
            "hdiutil",
            ["create", "-volname", "Openship", "-srcfolder", staging, "-ov", "-format", "UDZO", dmgPath],
            { stdio: "inherit" },
          );
          hdiutilErr = undefined;
          break;
        } catch (err) {
          hdiutilErr = err;
          if (attempt < 5) {
            console.warn(`postMake: hdiutil create failed (attempt ${attempt}/5) — retrying in 3s`);
            execFileSync("rm", ["-f", dmgPath]); // clear any partial image before retry
            await new Promise((r) => setTimeout(r, 3000));
          }
        }
      }
      if (hdiutilErr) throw hdiutilErr;
      execFileSync("rm", ["-rf", staging]);
      return makeResults;
    },
  },

  makers: [
    {
      name: "@reforged/maker-appimage",
      config: { options: { bin: "openship", icon: `${ICON_BASE}.png` } },
      platforms: ["linux"],
    },
    {
      // Windows ships as a zip. The Squirrel maker's bundled .exe tools
      // (Update.exe et al.) aren't found under bun's symlinked node_modules,
      // so releasify dies with "cannot find the file specified". A zip needs
      // no native tooling and builds reliably on the runner.
      name: "@electron-forge/maker-zip",
      platforms: ["darwin", "linux", "win32"],
    },
  ],
};
