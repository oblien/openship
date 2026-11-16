"use client";

import { ChatMarkdown } from "@mindwire-ai/client";
import { useContext, type ComponentProps } from "react";
import {
  CodeBlock,
  StreamdownContext,
  defaultComponents,
  useIsCodeFenceIncomplete,
  type Components,
  type ExtraProps,
} from "streamdown";
import { AssistantCopyButton } from "./AssistantCopyButton";
import styles from "./assistant-markdown.module.css";

export const assistantMarkdownComponents: Components = {
  code: AssistantCode,
  a: ({ href, children }) =>
    href ? (
      <a
        href={href}
        {...(/^(https?:)?\/\//i.test(href ?? "")
          ? { target: "_blank", rel: "noopener noreferrer" }
          : {})}
      >
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: ({ alt }) => <span className="text-muted-foreground">{alt || "Image"}</span>,
};
function AssistantCode(props: ComponentProps<"code"> & ExtraProps) {
  const { isAnimating } = useContext(StreamdownContext);
  const isIncomplete = useIsCodeFenceIncomplete();
  if (!("data-block" in props)) return <defaultComponents.code {...props} />;
  const language = /language-([^\s]+)/.exec(props.className ?? "")?.[1] ?? "text";
  const value = typeof props.children === "string" ? props.children.replace(/\n$/, "") : "";
  // Streamdown owns parsing/highlighting. Reuse our clipboard fallback for HTTP self-hosted dashboards.
  return (
    <CodeBlock code={value} language={language} isIncomplete={isIncomplete} lineNumbers={false}>
      <AssistantCopyButton value={value} label="Copy code" disabled={isAnimating} />
    </CodeBlock>
  );
}

/** Host controls, shared Markdown parsing and streaming. */
export function AssistantMarkdown({
  children,
  streaming = false,
}: {
  children: string;
  streaming?: boolean;
}) {
  return (
    <ChatMarkdown
      text={children}
      isAnimating={streaming}
      components={assistantMarkdownComponents}
      className={styles.markdown}
    />
  );
}
