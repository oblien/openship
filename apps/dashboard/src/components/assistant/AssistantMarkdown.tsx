"use client";

import { code } from "@streamdown/code";
import { useContext, type ComponentProps } from "react";
import {
  CodeBlock,
  Streamdown,
  StreamdownContext,
  defaultComponents,
  defaultRehypePlugins,
  useIsCodeFenceIncomplete,
  type Components,
  type ExtraProps,
  type StreamdownProps,
} from "streamdown";
import { AssistantCopyButton } from "./AssistantCopyButton";
import styles from "./assistant-markdown.module.css";

// Keep Streamdown's sanitizer, but omit its raw-HTML parser and permissive URL defaults.
const rehypePlugins: StreamdownProps["rehypePlugins"] = [defaultRehypePlugins.sanitize];
const urlTransform: StreamdownProps["urlTransform"] = (url, key) => {
  if (key !== "href") return undefined;
  try {
    const { protocol } = new URL(url, "https://openship.invalid");
    return ["https:", "http:", "mailto:"].includes(protocol) ? url : undefined;
  } catch {
    return undefined;
  }
};
const components: Components = {
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
const plugins = { code };
// Animate arriving words without queuing an artificial second stream behind the agent.
const animation: StreamdownProps["animated"] = {
  animation: "fadeIn",
  duration: 160,
  easing: "ease-out",
  sep: "word",
  stagger: 12,
  maxBacklogMs: 180,
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

/** One renderer for replies and reasoning, including partially received Markdown. */
export function AssistantMarkdown({
  children,
  streaming = false,
}: {
  children: string;
  streaming?: boolean;
}) {
  return (
    <Streamdown
      className={styles.markdown}
      data-assistant-markdown=""
      dir="auto"
      plugins={plugins}
      rehypePlugins={rehypePlugins}
      urlTransform={urlTransform}
      components={components}
      controls={false}
      skipHtml
      isAnimating={streaming}
      animated={animation}
      tableMaxHeight={0}
    >
      {children}
    </Streamdown>
  );
}
