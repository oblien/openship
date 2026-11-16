"use client";

import { useId, useState } from "react";
import { Icon } from "@repo/ui/icons";
import { deployLinkHref, type DeploySource } from "@repo/core";
import { useCopy } from "@/i18n/use-copy";

const buttonStyles = [
  { id: "light", label: "Light", image: "/deploy-light.svg" },
  { id: "dark", label: "Dark", image: "/deploy.svg" },
] as const;

export function DeployReadme({
  source,
  copied,
  onCopy,
}: {
  source: DeploySource;
  copied: string | null;
  onCopy: (text: string) => Promise<void>;
}) {
  const copy = useCopy();
  const groupId = useId();
  const [style, setStyle] = useState<(typeof buttonStyles)[number]>(buttonStyles[1]);
  const markdown = `[![Deploy with OpenShip](https://openship.io${style.image})](https://openship.io${deployLinkHref(source)})`;

  return (
    <details className="deploy-share">
      <summary>
        <Icon name="code" size={17} />
        {copy("Add this button to your README")}
        <Icon name="chevron-down" size={15} />
      </summary>
      <div className="deploy-share-content">
        <div className="deploy-share-preview-row">
          <img
            className="deploy-button-preview"
            src={style.image}
            width={212}
            height={40}
            alt={copy("Deploy with OpenShip")}
          />
          <fieldset className="deploy-button-styles">
            <legend className="sr-only">{copy("Button style")}</legend>
            <div className="deploy-button-switch">
              {buttonStyles.map((option) => (
                <label className="deploy-button-choice" key={option.id}>
                  <input
                    type="radio"
                    name={groupId}
                    value={option.id}
                    checked={style.id === option.id}
                    onChange={() => setStyle(option)}
                  />
                  <span>{copy(option.label)}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>
        <div className="deploy-share-code">
          <div className="deploy-share-code-heading">
            <span>{copy("README Markdown")}</span>
            <button
              type="button"
              className="deploy-text-link"
              aria-label={copy(copied === markdown ? "Copied" : "Copy Markdown")}
              onClick={() => onCopy(markdown)}
            >
              <Icon name={copied === markdown ? "check" : "copy"} size={16} />
              {copy(copied === markdown ? "Copied" : "Copy")}
            </button>
          </div>
          <pre>
            <code>{markdown}</code>
          </pre>
        </div>
      </div>
    </details>
  );
}
