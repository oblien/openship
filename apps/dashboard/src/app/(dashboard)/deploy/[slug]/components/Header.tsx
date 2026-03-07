import React from "react";
import { ArrowLeft, GitBranch, Globe, Lock } from "lucide-react";
import { HeaderProps } from "@/components/import-project/types";
import Link from "next/link";
import { generateIcon } from "@/utils/icons";

const Header: React.FC<HeaderProps> = ({ repoData }) => {
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
              {repoData.owner}/{repoData.repo}
            </h1>
            <div className="flex items-center gap-2 text-sm">
              {repoData.private ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-700 ring-1 ring-amber-500/20 font-semibold text-xs">
                  <Lock className="w-3 h-3" />
                  Private
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-700 ring-1 ring-emerald-500/20 font-semibold text-xs">
                  <Globe className="w-3 h-3" />
                  Public
                </span>
              )}
              <span className="text-gray-300">•</span>
              <span className="inline-flex items-center gap-1 text-gray-500">
                <GitBranch className="w-3 h-3" />
                <span className="text-xs font-medium">{repoData.branch}</span>
              </span>
            </div>
          </div>
        </div>

        <button
          className="flex items-center gap-2 px-4 py-2 bg-gray-100 text-gray-600 hover:text-black text-sm font-medium rounded-[15px] transition-all"
          type="button"
        >
          {generateIcon('help%20sign-50-1658435663.png', 16, 'currentColor')}
          <span>Help</span>
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
