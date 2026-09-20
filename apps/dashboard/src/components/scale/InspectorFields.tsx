"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { Info, Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { Switch } from "@/components/ui/Switch";

export function Section({
  title,
  children,
  description,
}: {
  title: string;
  children: ReactNode;
  description?: string;
}) {
  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        {description && (
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-xl bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
      <Info className="mt-0.5 size-3.5 shrink-0" />
      <p>{children}</p>
    </div>
  );
}

export function TextField({
  label,
  value,
  onChange,
  path = false,
  required = true,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  path?: boolean;
  required?: boolean;
  placeholder?: string;
}) {
  const id = useId();
  const [text, setText] = useState(value);
  const [error, setError] = useState("");
  useEffect(() => setText(value), [value]);
  return (
    <div className="space-y-2">
      <label className="text-sm text-muted-foreground" htmlFor={id}>
        {label}
      </label>
      <Input
        id={id}
        value={text}
        placeholder={placeholder}
        maxLength={path ? 200 : 60}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => {
          setText(event.target.value);
          setError("");
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        onBlur={() => {
          const next = text.trim();
          if ((required && !next) || (path && !next.startsWith("/"))) {
            setText(value);
            setError(path ? "Use a path starting with /." : "A name is required.");
          } else {
            setText(next);
            onChange(next);
          }
        }}
      />
      {error && (
        <p className="text-xs text-danger" role="alert" id={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}

export function NumberField({
  label,
  value,
  min,
  max,
  onChange,
  step = 1,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  step?: number;
}) {
  const id = useId();
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="text-sm text-muted-foreground">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-10 shrink-0"
          aria-label={`Decrease ${label.toLowerCase()}`}
          disabled={value <= min}
          onClick={() => onChange(Math.max(min, value - step))}
        >
          <Minus />
        </Button>
        <Input
          id={id}
          type="number"
          min={min}
          max={max}
          step={step}
          value={text}
          className="h-10 min-w-0 text-center tabular-nums"
          onChange={(event) => {
            const next = event.target.value;
            setText(next);
            const number = Number(next);
            if (next && Number.isInteger(number) && number >= min && number <= max)
              onChange(number);
          }}
          onBlur={() => setText(String(value))}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-10 shrink-0"
          aria-label={`Increase ${label.toLowerCase()}`}
          disabled={value >= max}
          onClick={() => onChange(Math.min(max, value + step))}
        >
          <Plus />
        </Button>
      </div>
    </div>
  );
}

export function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <fieldset className="min-w-0">
      <legend className="mb-2 text-sm text-muted-foreground">{label}</legend>
      <CustomSelect value={value} options={options} onChange={onChange} />
    </fieldset>
  );
}

export function ToggleField({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <p className="text-sm text-foreground/80">{label}</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
      </div>
      <Switch checked={checked} onChange={onChange} disabled={disabled} ariaLabel={label} />
    </div>
  );
}
