// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAssistantImages } from "./use-assistant-images";

let root: Root;
let host: HTMLDivElement;
let state: ReturnType<typeof useAssistantImages>;
function Harness() {
  state = useAssistantImages();
  return null;
}
beforeEach(async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("keeps clear stable across renders so conversation handoff does not reset a submitted message", async () => {
  const clear = state.clear;
  await act(async () => state.remove("image"));
  expect(state.clear).toBe(clear);
  await act(async () => state.clear());
  expect(state.clear).toBe(clear);
});

it("discards an image read completed after leaving its conversation", async () => {
  let reader: { result: string; onload?: () => void };
  vi.stubGlobal(
    "FileReader",
    class {
      result = "data:image/png;base64,aW1hZ2U=";
      onload?: () => void;
      readAsDataURL() {
        reader = this;
      }
    },
  );
  let adding: Promise<void>;
  await act(async () => {
    adding = state.add([new File(["image"], "image.png", { type: "image/png" })]);
  });
  expect(state.pending).toBe(true);
  await act(async () => state.clear());
  await act(async () => {
    reader.onload?.();
    await adding;
  });
  expect(state.images).toEqual([]);
  expect(state.pending).toBe(false);
  expect(state.error).toBeNull();
});

it("clears sent previews and restores the original image IDs and bytes for a failed-send retry", async () => {
  const png = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7WQAAAAASUVORK5CYII=",
    ),
    (character) => character.charCodeAt(0),
  );
  await act(async () => state.add([new File([png], "status.png", { type: "image/png" })]));
  const submitted = state.images;
  expect(state.error).toBeNull();
  expect(submitted).toHaveLength(1);
  const restore = state.restore;
  await act(async () => state.clear());
  expect(state.images).toEqual([]);
  await act(async () => state.restore(submitted));
  expect(state.images).toEqual(submitted);
  expect(state.restore).toBe(restore);
  expect(state.pending).toBe(false);
  expect(state.error).toBeNull();
});
