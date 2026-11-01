import { expect, test } from "bun:test";
import { once } from "node:events";
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants,
  createBrotliDecompress,
} from "node:zlib";

// Node.js's public CVE-2026-111497 regression case. Keep the actual decoder
// behavior covered: a version string alone cannot establish that the fix shipped.
// https://github.com/nodejs/node/blob/v22.23.4/test/parallel/test-zlib-invalid-input.js
const invalidBlockSwitch = Buffer.from("200010414141fcffff07002228f00b60f7f41f000000", "hex");

test("the release toolchain rejects an invalid Brotli block switch", () => {
  expect(constants.BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH).toBe(-17);
  expect(() => brotliDecompressSync(invalidBlockSwitch)).toThrow(
    expect.objectContaining({ code: "ERR__ERROR_FORMAT_BLOCK_SWITCH", errno: -17 }),
  );
  const valid = Buffer.from("Openship runtime regression check");
  expect(brotliDecompressSync(brotliCompressSync(valid))).toEqual(valid);
});

test("streaming decompression rejects the same input across chunk boundaries", async () => {
  const decoder = createBrotliDecompress();
  decoder.resume();
  const error = once(decoder, "error");
  for (const byte of invalidBlockSwitch) decoder.write(Buffer.from([byte]));
  decoder.end();
  const [result] = await error;
  expect(result).toMatchObject({ code: "ERR__ERROR_FORMAT_BLOCK_SWITCH", errno: -17 });
});
