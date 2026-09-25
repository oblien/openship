/** A filename within the configured icon asset directory, never a component URL. */
export interface IconAsset {
  readonly file: string;
  /** Masks inherit currentColor; colorful artwork keeps its original pixels. */
  readonly mode: "mask" | "color";
  /** Visible PNG bounds in a 24-unit canvas, used to remove source padding. */
  readonly bounds?: readonly [x: number, y: number, width: number, height: number];
  /** Visible inset within the 24-unit viewport when bounds are supplied. Defaults to 1. */
  readonly inset?: number;
}
