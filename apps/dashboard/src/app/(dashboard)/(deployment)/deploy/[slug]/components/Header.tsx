"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import React from "react";
import { HeaderProps } from "@/components/import-project/types";
import Link from "next/link";

import { useI18n } from "@/components/i18n-provider";

const Header: React.FC<HeaderProps> = ({ repoData }) => {
  const { t } = useI18n();
  // Local-sourced deploys use "local" as a sentinel owner and have no remote
  // repo to open — only link real GitHub repos.
  const isRemoteRepo = !!repoData.owner && repoData.owner !== "local" && !!repoData.repo;
  const repoUrl = `https://github.com/${repoData.owner}/${repoData.repo}`;
  return (
    <div className="mb-6 relative mt-10">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          {/* <Link
            href="/deployments"
            className="inline-flex items-center justify-center w-10 h-10 rounded-xl hover:bg-gray-100 text-gray-600 hover:text-black transition-all"
          >
            <ArrowLeft className="w-5 h-5" />
          </Link>
           */}
          <div>
            <h1
              className="font-bold text-black mb-2"
              style={{ fontSize: '2.4rem', letterSpacing: '-0.5px' }}
            >
              {isRemoteRepo ? (
                <a
                  href={repoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline-offset-4 transition-colors hover:text-primary hover:underline"
                >
                  {repoData.owner}/{repoData.repo}
                </a>
              ) : (
                <>{repoData.owner}/{repoData.repo}</>
              )}
            </h1>
            <div className="flex items-center gap-2 text-sm">
              {repoData.private ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-warning-bg text-warning ring-1 ring-warning-border font-semibold text-xs">
                  <UiIcon name="lock" className="w-3 h-3" />
                  {t.deploy.header.private}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-success-bg text-success ring-1 ring-success-border font-semibold text-xs">
                  <UiIcon name="globe" className="w-3 h-3" />
                  {t.deploy.header.public}
                </span>
              )}
              <span className="text-gray-300">•</span>
              <span className="inline-flex items-center gap-1 text-gray-500">
                <UiIcon name="git-branch" className="w-3 h-3" />
                <span className="text-xs font-medium">{repoData.branch}</span>
              </span>
            </div>
          </div>
        </div>

        <button
          className="flex items-center gap-2 px-4 py-2 bg-gray-100 text-gray-600 hover:text-black text-sm font-medium rounded-[15px] transition-all"
          type="button"
        >
          <UiIcon name="help-circle" size={16} />
          <span>{t.deploy.header.help}</span>
        </button>
      </div>
      
      {/* Gradient underline */}
      {/* <div 
        className="absolute left-14"
        style={{
          bottom: '-1.5rem',
          width: '100px',
          height: '4px',
          background: 'linear-gradient(90deg, #36b37e, #00c6ff)',
          borderRadius: '30px',
        }}
      ></div> */}
    </div>
  );
};

export default React.memo(Header);
