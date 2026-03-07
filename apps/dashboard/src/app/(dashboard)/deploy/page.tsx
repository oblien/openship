"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * This page redirects to the deployments list.
 * Individual repository deployments are now handled at /deploy/[slug]
 * where slug is a base64url-encoded owner/repo string.
 */
const DeployRedirect = () => {
  const router = useRouter();

  useEffect(() => {
    // Redirect to the deployments page to select a repository
    router.replace("/library");
  }, [router]);

  return (
    <div className="min-h-screen bg-zinc-900 text-white flex items-center justify-center">
      <div className="text-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-white mx-auto mb-4"></div>
        <p className="text-gray-400">Redirecting to library...</p>
      </div>
    </div>
  );
};

export default DeployRedirect;
