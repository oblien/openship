"use client";

import { AppLogo } from "@/components/AppLogo";
import { useImageFallback } from "@/hooks/useImageFallback";
import { ProjectStackIcon } from "./ProjectStackIcon";

/** One display order everywhere: project icon, catalog logo, then stack icon. */
export function ProjectIcon({
  project,
  appTemplateId,
  className = "size-6",
}: {
  project: {
    iconUrl?: string | null;
    framework?: string | null;
    serviceDeploymentMode?: "single" | "services";
  };
  appTemplateId?: string | null;
  className?: string;
}) {
  const src = project.iconUrl;
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
  if (appTemplateId)
    return <AppLogo appId={appTemplateId} className={`${className} object-contain`} />;
  return (
    <ProjectStackIcon
      framework={project.framework}
      serviceDeploymentMode={project.serviceDeploymentMode}
      className={className}
    />
  );
}
