/**
 * Section header - the ruled grid's chapter marker.
 *
 * One per converted section, and always its first child: it is sticky, so
 * being scoped to the section is what makes it hand over to the next header
 * instead of piling up under the navbar.
 *
 * The counter is passed in rather than derived. The order of the sections is
 * a property of the page, not of any one section, so the page is the only
 * place that should have to know it.
 */
export function SectionHeader({
  label,
  index,
  total,
}: {
  label: string;
  index: number;
  total: number;
}) {
  return (
    <div className="lp-band lp-sechead">
      <div className="lp-band-in lp-sechead-in">
        <span className="lp-sechead-label">
          <span className="lp-sechead-chevron" aria-hidden="true">
            &#12297;
          </span>
          {label}
        </span>
        <span className="lp-sechead-rule" aria-hidden="true" />
        <span className="lp-sechead-count">
          [<span className="lp-sechead-count-n">{index}</span>/{total}]
        </span>
      </div>
    </div>
  );
}
