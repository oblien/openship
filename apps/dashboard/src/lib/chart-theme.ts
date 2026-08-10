/**
 * Shared recharts styling.
 *
 * Lives here rather than beside one chart because it encodes a THEME fact that any
 * chart can get wrong, and did: see the note on CHART_TOOLTIP_STYLE.
 */

/**
 * Shared recharts `contentStyle` for every tooltip on this surface.
 *
 * A tooltip is a dropdown-class surface, so it takes the dropdown tokens: opaque
 * `--popover` (which resolves to `--th-dropdown-bg`) and the theme's own floating-panel
 * shadow. NOT `--color-card` — in the dark themes `--th-card-bg` is
 * `rgba(255,255,255,.05)`, five percent white, which is right for a card sitting ON a
 * background and wrong for a panel floating OVER a chart: the series showed straight
 * through the tooltip and the text became unreadable.
 *
 * Opaque, with no `backdrop-filter` anywhere. The glass version (popover at 82% plus a
 * heavy blur) read as a grey slab behind the text rather than as the surface every other
 * floating panel in the app uses.
 *
 * Every property has to be inline: recharts merges its own inline contentStyle defaults
 * (`backgroundColor: #fff`, `border: 1px solid #ccc`, `padding: 10`) into the same style
 * attribute, and a stylesheet cannot override those. `backgroundColor` rather than the
 * `background` shorthand so it REPLACES recharts' own key instead of depending on
 * declaration order to beat it.
 *
 * One constant rather than a copy per chart — two hand-maintained tooltip styles is how
 * one of them silently keeps the wrong background.
 */
export const CHART_TOOLTIP_STYLE = {
  backgroundColor: "var(--color-popover)",
  border: "1px solid var(--color-border)",
  /* --th-* because the shadow is the one part with no --color-* equivalent. It is a
     single var that already differs per theme (one heavy enough to read on black is a
     dirty smudge on white), so it needs no per-theme CSS block. */
  boxShadow: "var(--th-dropdown-shadow)",
  borderRadius: 12,
  fontSize: 12,
  padding: "8px 10px",
  color: "var(--color-foreground)",
} as const;

/** Muted label row inside the tooltip (the timestamp / series name). */
export const CHART_TOOLTIP_LABEL_STYLE = {
  color: "var(--color-muted-foreground)",
  marginBottom: 2,
} as const;

/**
 * The hover indicator recharts draws on the plot.
 *
 * Explicit because the DEFAULT is a filled `#ccc` rectangle spanning the active
 * category — which on a light card rendered as a mystery white block hanging below the
 * tooltip. A dashed line says "this x position" without inventing a shape.
 */
export const CHART_CURSOR = {
  stroke: "var(--color-border)",
  strokeWidth: 1,
  strokeDasharray: "3 3",
} as const;

/* Deliberately NO tooltip class constant. recharts 3 forwards `wrapperClassName` to the
   CONTENT div (`.recharts-default-tooltip`), not to the positioned wrapper it named in
   v2, so a class of ours meant two different elements depending on the chart — and a
   `> *` rule written for the v2 meaning styled the label <p> and the item <ul>
   separately. What CSS still owns is the stacking order, keyed off recharts' own
   `.recharts-tooltip-wrapper` in styles/chart.css. */
