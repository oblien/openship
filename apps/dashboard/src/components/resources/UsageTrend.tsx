/** Recent samples from this open page only. Gaps remain gaps; never fabricate
 * historical provider usage before a subscription was opened. */
export function UsageTrend({ values, max }: { values: (number | null)[]; max: number | null }) {
  if (values.filter((value) => value !== null).length < 2)
    return (
      <svg viewBox="0 0 240 48" className="h-12 w-full text-muted-foreground/20" aria-hidden>
        <path d="M0 44 H240" stroke="currentColor" strokeWidth="1" strokeDasharray="3 5" />
      </svg>
    );
  const upper = Math.max(max ?? 0, ...values.filter((value): value is number => value !== null), 1);
  const points = values.map((value, index) =>
    value === null
      ? null
      : `${(index / Math.max(values.length - 1, 1)) * 240},${44 - Math.min(value / upper, 1) * 40}`,
  );
  const paths: string[] = [];
  let segment = "";
  for (const point of points) {
    if (point === null) {
      if (segment) paths.push(segment);
      segment = "";
    } else segment += `${segment ? " L" : "M"}${point}`;
  }
  if (segment) paths.push(segment);
  return (
    <svg
      viewBox="0 0 240 48"
      preserveAspectRatio="none"
      className="h-12 w-full text-primary"
      aria-hidden
    >
      {paths.map((path, index) => (
        <path
          key={index}
          d={path}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          vectorEffect="non-scaling-stroke"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}
