module.exports = {
  packagerConfig: {
    asar: true,
    appBundleId: "com.oblien.openship.mail",
    appCategoryType: "public.app-category.productivity",
    icon: "../desktop/assets/icon",
    prune: false,
    ignore: (path) =>
      path.endsWith(".tsx") ||
      (Boolean(path) &&
        !/^\/(launcher|dist)(\/|$)|^\/(main\.cjs|connections\.cjs|window\.cjs|preload\.cjs|package\.json)$/.test(
          path,
        )),
    ...(process.env.APPLE_IDENTITY && { osxSign: { identity: process.env.APPLE_IDENTITY } }),
  },
  makers: [{ name: "@electron-forge/maker-zip", platforms: ["darwin", "win32", "linux"] }],
};
