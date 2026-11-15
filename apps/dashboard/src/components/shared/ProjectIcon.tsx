"use client";

import { projectIconUrl } from "@repo/core";
import { AppLogo } from "@/components/AppLogo";
import { useImageFallback } from "@/hooks/useImageFallback";
import { ProjectStackIcon } from "./ProjectStackIcon";

/** Custom URL, existing catalog/discovery preference, then the stack fallback. */
export function ProjectIcon({
  project,
  appTemplateId,
  preferAppLogo = false,
  className = "size-6",
}: {
  project: {
    iconUrl?: string | null;
    favicon?: string | null;
    framework?: string | null;
    serviceDeploymentMode?: "single" | "services";
  };
  appTemplateId?: string | null;
  preferAppLogo?: boolean;
  className?: string;
}) {
  const src = project.iconUrl || (preferAppLogo && appTemplateId ? null : projectIconUrl(project));
  const image = useImageFallback(src);
  if (image.showImage)
    return (
      <img
        ref={image.ref}
        src={src!}
        alt=""
        onError={image.onError}
        referrerPolicy="no-referrer"
        className={`${className} object-contain`}
      />
    );
  if (preferAppLogo && appTemplateId)
    return <AppLogo appId={appTemplateId} className={`${className} object-contain`} />;
  return (
    <ProjectStackIcon
      framework={project.framework}
      serviceDeploymentMode={project.serviceDeploymentMode}
      className={className}
    />
  );
}
