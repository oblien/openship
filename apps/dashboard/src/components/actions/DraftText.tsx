"use client";
import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";

/** Preserve partially typed separators while the YAML model receives normalized values. */
function useDraftText(
  value: string,
  change: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void,
) {
  const [text, setText] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(value);
  }, [value]);
  return {
    value: text,
    onFocus: () => {
      focused.current = true;
    },
    onBlur: () => {
      focused.current = false;
      setText(value);
    },
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setText(event.target.value);
      change(event);
    },
  };
}
export function DraftTextarea({
  value,
  onChange,
  ...props
}: Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & {
  value: string;
  onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
}) {
  return <textarea {...props} {...useDraftText(value, onChange)} />;
}
export function DraftInput({
  value,
  onChange,
  ...props
}: Omit<React.ComponentProps<typeof Input>, "value" | "onChange"> & {
  value: string;
  onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
}) {
  return <Input {...props} {...useDraftText(value, onChange)} />;
}
