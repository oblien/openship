export interface PackedArchive {
  name: string;
  version: string;
  filename: string;
  size: number;
  unpackedSize: number;
}

/** npm 12 keys pack reports by package name; earlier versions return an array. */
export function readPackedArchive(
  output: string,
  expected: { name: string; version: string },
): PackedArchive {
  const report: unknown = JSON.parse(output);
  const archives = Array.isArray(report)
    ? report
    : report && typeof report === "object"
      ? Object.values(report)
      : [];
  if (archives.length !== 1)
    throw new Error("npm pack must produce exactly one package archive.");
  const archive = archives[0];
  if (
    !archive ||
    archive.name !== expected.name ||
    archive.version !== expected.version ||
    typeof archive.filename !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.tgz$/.test(archive.filename) ||
    !Number.isSafeInteger(archive.size) || archive.size <= 0 ||
    !Number.isSafeInteger(archive.unpackedSize) || archive.unpackedSize <= 0
  ) throw new Error(`npm pack did not report a valid archive for ${expected.name}@${expected.version}.`);
  return archive;
}
