/**
 * A stand-in for a module-level singleton that is resolved on every property
 * read instead of when the stand-in is created.
 *
 * Use it as a default argument when a factory runs at import time and its
 * dependency lives in a module that can still be initialising through an
 * import cycle. Capturing the singleton directly (`runtime = assistant`) binds
 * whatever the binding holds at that moment: in the bundled API that is
 * `undefined`, so every later call fails with "Cannot read properties of
 * undefined" long after startup. Reading through the stand-in defers the lookup
 * until the first real call, when every module has finished evaluating.
 *
 * Functions are bound to the resolved target so methods that rely on `this`
 * keep working.
 */
export function deferred<T extends object>(resolve: () => T): T {
  return new Proxy({} as T, {
    get(_stub, key) {
      const target = resolve();
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    has(_stub, key) {
      return Reflect.has(resolve(), key);
    },
  });
}
