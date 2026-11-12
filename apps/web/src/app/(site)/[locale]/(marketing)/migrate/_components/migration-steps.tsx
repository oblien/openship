import { useCopy } from "@/i18n/use-copy";

export function MigrationSteps({ steps }: { steps: { title: string; description: string }[] }) {
  const copy = useCopy();

  return (
    <ol className="mg-steps">
      {steps.map((step, index) => (
        <li key={step.title}>
          <span className="mg-step-number" aria-hidden="true">
            {String(index + 1).padStart(2, "0")}
          </span>
          <div>
            <h3>{copy(step.title)}</h3>
            <p>{copy(step.description)}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
