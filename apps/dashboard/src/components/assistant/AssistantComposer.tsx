"use client";

import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Icon } from "@repo/ui/icons";
import { Button } from "@/components/ui/button";
import { ASSISTANT_IMAGE_TYPES } from "@repo/contracts";
import type { ComposerImage } from "./use-assistant-images";

/** One composer for the opening prompt and an ongoing conversation. */
export function AssistantComposer({
  value,
  onChange,
  onSend,
  onStop,
  controls,
  active,
  canMessageWhileActive = false,
  busy,
  disabled,
  canSend,
  compact = false,
  placeholder = "Ask about your apps, or describe what you want to do…",
  inputRef,
  images = [],
  onImages,
  onRemoveImage,
  imageError,
  imagesPending = false,
  imagesSupported = false,
}: {
  value: string;
  onChange(value: string): void;
  onSend(): void;
  onStop(): void;
  controls: ReactNode;
  active: boolean;
  canMessageWhileActive?: boolean;
  busy: boolean;
  disabled: boolean;
  canSend: boolean;
  compact?: boolean;
  placeholder?: string;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  images?: ComposerImage[];
  onImages?(files: File[]): void;
  onRemoveImage?(id: string): void;
  imageError?: string | null;
  imagesPending?: boolean;
  imagesSupported?: boolean;
}) {
  const localInput = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const input = inputRef ?? localInput;
  const canAttach = imagesSupported && !active && !disabled && !busy && !!onImages;
  const sendable =
    canSend &&
    !disabled &&
    !busy &&
    (!active || canMessageWhileActive) &&
    !imagesPending &&
    (!!value.trim() || !!images.length) &&
    (!images.length || imagesSupported);
  useLayoutEffect(() => {
    const field = input.current;
    if (!field) return;
    const resize = () => {
      // Empty inputs use their two-row baseline, not a previous draft's
      // measured height or the height of a wrapped placeholder.
      if (!value) {
        field.style.height = "auto";
        field.scrollTop = 0;
        return;
      }
      field.style.height = "0px";
      field.style.height = `${field.scrollHeight}px`;
    };
    resize();
    // Sidebar and viewport changes can wrap an unchanged draft onto more lines.
    let width = field.clientWidth;
    const observer = new ResizeObserver(() => {
      if (field.clientWidth === width) return;
      width = field.clientWidth;
      resize();
    });
    observer.observe(field);
    return () => observer.disconnect();
  }, [value, input, compact]);
  return (
    <form
      aria-label="Message composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (sendable) onSend();
      }}
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        dragDepth.current++;
        if (canAttach) setDragging(true);
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDragLeave={() => {
        if (--dragDepth.current <= 0) {
          dragDepth.current = 0;
          setDragging(false);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        if (canAttach) onImages?.(Array.from(event.dataTransfer.files));
      }}
      className={`relative rounded-3xl bg-card/80 p-3 shadow-[0_2px_16px_-8px_rgb(0_0_0/0.18)] backdrop-blur-xl ${compact ? "sm:px-4" : "sm:p-4"} ${dragging ? "ring-1 ring-foreground/40" : ""}`}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-3xl bg-card/95 text-sm font-medium">
          Drop images here
        </div>
      )}
      {!!images.length && (
        <div className="mb-3 flex flex-wrap gap-2 px-1" aria-label="Attached images">
          {images.map((image) => (
            <div key={image.id} className="relative">
              {/* Validated local bytes only; never a model-supplied remote image URL. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`data:${image.mime};base64,${image.data}`}
                alt={image.name}
                title={image.name}
                className="size-20 rounded-xl bg-background object-cover"
              />
              <button
                type="button"
                aria-label={`Remove ${image.name}`}
                disabled={busy}
                onClick={() => onRemoveImage?.(image.id)}
                className="absolute -end-1 -top-1 flex size-6 items-center justify-center rounded-full bg-foreground text-background shadow-sm focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Icon name="close" className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={input}
        aria-label="Message your assistant"
        placeholder={placeholder}
        rows={2}
        maxLength={32000}
        value={value}
        disabled={disabled || busy}
        onChange={(event) => onChange(event.target.value)}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.files);
          if (!files.length || !canAttach) return;
          event.preventDefault();
          onImages?.(files);
        }}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing &&
            event.nativeEvent.keyCode !== 229 &&
            !window.matchMedia("(pointer: coarse)").matches
          ) {
            event.preventDefault();
            if (sendable) onSend();
          }
        }}
        className={`block max-h-[min(168px,25dvh)] ${compact ? "min-h-16" : "min-h-20"} w-full resize-none overflow-y-auto bg-transparent px-2 py-1 text-base leading-7 text-foreground placeholder:text-muted-foreground focus:outline-none disabled:opacity-60`}
      />
      {imageError && (
        <p role="alert" className="px-2 pt-2 text-xs text-danger">
          {imageError}
        </p>
      )}
      <div className={`${compact ? "mt-2" : "mt-3"} flex items-center gap-1 sm:gap-2`}>
        {onImages && (
          <>
            <input
              ref={fileInput}
              type="file"
              accept={ASSISTANT_IMAGE_TYPES.join(",")}
              multiple
              hidden
              aria-label="Upload images"
              onChange={(event) => {
                if (canAttach) onImages(Array.from(event.target.files ?? []));
                event.target.value = "";
              }}
            />
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="Attach images"
              title={
                imagesSupported
                  ? "Attach images · PNG, JPEG, WebP"
                  : "Images are unavailable for this agent"
              }
              className="size-10 shrink-0 rounded-full text-muted-foreground hover:text-foreground [&_svg]:size-[18px]"
              disabled={!canAttach || imagesPending}
              onClick={() => fileInput.current?.click()}
            >
              <Icon
                name={imagesPending ? "spinner" : "plus"}
                className={imagesPending ? "motion-safe:animate-spin" : ""}
              />
            </Button>
          </>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-1">{controls}</div>
        {active && (
          <Button
            type="button"
            size="icon"
            variant="secondary"
            aria-label="Stop response"
            className="size-10 shrink-0 rounded-full"
            disabled={busy}
            onClick={onStop}
          >
            <span aria-hidden="true" className="size-3 rounded-[2px] bg-current" />
          </Button>
        )}
        {(!active || (canMessageWhileActive && !!value.trim())) && (
          <Button
            size="icon"
            type="submit"
            aria-label="Send message"
            className="size-10 shrink-0 rounded-full"
            disabled={!sendable}
          >
            <Icon
              name={busy ? "spinner" : "arrow-right"}
              className={busy ? "animate-spin" : "-rotate-90"}
            />
          </Button>
        )}
      </div>
    </form>
  );
}
