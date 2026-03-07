"use client";

import React, { useState, useMemo, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import GithubConnectionPrompt from "./components/GithubConnectionPrompt";
import OwnerSelector from "./components/OwnerSelector";
import RepositoryFilters from "./components/RepositoryFilters";
import RepositoryList from "./components/RepositoryList";
import AddRepositoryModal from "./components/AddRepositoryModal";
import RepositoryListSkeleton from "./components/RepositoryListSkeleton";
import OwnerSelectorSkeleton from "./components/OwnerSelectorSkeleton";
import RepositoryFiltersSkeleton from "./components/RepositoryFiltersSkeleton";
import { githubApi } from "@/lib/api";
import { Repository, Account, VisibilityFilter, SortBy } from "./types";
import { encodeRepoSlug, extractOwnerRepoFromUrl } from "@/utils/repoSlug";
import generateIcon from "@/utils/icons";
import { useToast } from "@/context/ToastContext";
import { handleConnectGithub } from '@/utils/github';
import { SectionContainer } from "@/components/ui/SectionContainer";

const DeploymentDashboard: React.FC = () => {
  const [searchTerm, setSearchTerm] = useState<string>("");
  const [visibilityFilter, setVisibilityFilter] = useState<VisibilityFilter>("all");
  const [sortBy, setSortBy] = useState<SortBy>("updated");
  const [selectedOwner, setSelectedOwner] = useState<string>("");
  const [loadingAccounts, setLoadingAccounts] = useState<boolean>(true);
  const [loadingRepos, setLoadingRepos] = useState<boolean>(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [isGithubConnected, setIsGithubConnected] = useState<boolean>(false);
  const [showManualRepoModal, setShowManualRepoModal] = useState<boolean>(false);
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [userLogin, setUserLogin] = useState<string>("");
  const previousOwner = useRef<string>("");
  const [viewMode, setViewMode] = useState<"list" | "grid">("grid");
  const [pendingGithubAppUrl, setPendingGithubAppUrl] = useState<string | null>(null);
  const [githubLoading, setGithubLoading] = useState<boolean>(false);
  const router = useRouter();
  const { showToast } = useToast();
  const isLoadingRef = useRef<boolean>(false);
  // Function to check and load GitHub connection data
  const checkGithubConnection = async () => {
    if (isLoadingRef.current) return;
    isLoadingRef.current = true;
    setLoadingAccounts(true);
    const response = await githubApi.getUserHome();
    console.log(response);

    if (response?.status?.connected && response.accounts?.length > 0) {
      setIsGithubConnected(true);
      setAccounts(response.accounts);
      setUserLogin(response.status.login);
      setSelectedOwner(response.status.login);
      previousOwner.current = response.status.login;
      setRepositories(response.repos);
    }else {
      setIsGithubConnected(false);
    }

    setLoadingAccounts(false);
    isLoadingRef.current = false;
  };

  // Check GitHub connection on mount
  useEffect(() => {
    checkGithubConnection();
  }, []);

  // Fetch repositories when selected owner changes (but not on initial load)
  useEffect(() => {
    const fetchRepos = async () => {
      // Skip if no owner, not connected, or owner hasn't actually changed
      if (!selectedOwner || !isGithubConnected || previousOwner.current === selectedOwner) return;

      // Update previous owner
      previousOwner.current = selectedOwner;

      setLoadingRepos(true);

      try {
        let response;

        // Check if selected owner is the user or an organization
        if (accounts.find((account: Account) => account.login === selectedOwner)?.type === 'Organization') {
          response = await githubApi.getOrgRepos(selectedOwner);
          // Fetch user's own repositories
        } else {
          response = await githubApi.getUserRepos(selectedOwner);
          // Fetch organization repositories
        }

        if (response && !response.error) {
          // Map repos to include owner field
          const reposWithOwner = response.map((repo: any) => ({
            ...repo,
            owner: repo.owner?.login || selectedOwner,
          }));
          setRepositories(reposWithOwner);
        } else {
          console.error('Failed to fetch repos:', response?.error);
          setRepositories([]);
        }
      } catch (error) {
        console.error('Error fetching repositories:', error);
        setRepositories([]);
      } finally {
        setLoadingRepos(false);
      }
    };

    fetchRepos();
  }, [selectedOwner, isGithubConnected, userLogin]);


  const filteredAndSortedRepos = useMemo<Repository[]>(() => {
    if (!Array.isArray(repositories)) return [];
    let filtered = repositories.filter((repo) => {
      const matchesSearch =
        repo.name?.toLowerCase()?.includes(searchTerm.toLowerCase()) ||
        repo.description?.toLowerCase()?.includes(searchTerm.toLowerCase());

      const matchesVisibility =
        visibilityFilter === "all" ||
        (visibilityFilter === "public" && !repo.private) ||
        (visibilityFilter === "private" && repo.private);

      return matchesSearch && matchesVisibility;
    });

    filtered.sort((a, b) => {
      switch (sortBy) {
        case "name":
          return a.name.localeCompare(b.name);
        case "stars":
          return b.stars - a.stars;
        case "updated":
        default:
          return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
      }
    });

    return filtered;
  }, [searchTerm, visibilityFilter, sortBy, repositories]);

  const handleDeploy = (repo: Repository): void => {
    console.log("Deploying:", repo);
    const slug = encodeRepoSlug(repo.owner, repo.name);
    router.push(`/deploy/${slug}`);
  };

  const handleManualRepoDeploy = (url: string): void => {
    console.log("Deploying manual repo:", url);
    setShowManualRepoModal(false);

    // Extract owner/repo from URL and navigate
    const extracted = extractOwnerRepoFromUrl(url);
    if (extracted) {
      const slug = encodeRepoSlug(extracted.owner, extracted.repo);
      router.push(`/deploy/${slug}`);
    } else {
      showToast("Invalid GitHub URL", "error");
      // TODO: Show error message to user
    }
  };

  const handleContinueToGithubApp = () => {
    if (pendingGithubAppUrl) {
      window.open(pendingGithubAppUrl, '_blank');
      setPendingGithubAppUrl(null);
      // Check connection after a delay
      setTimeout(() => {
        checkGithubConnection();
      }, 3000);
    }
  };

  const handleEditWithBlurs = (repo: Repository): void => {
    console.log("Editing with Blurs:", repo);
    showToast("Editing with Blurs is not available yet", "error");
  };

  const handleMenu = (repo: Repository): void => {
    console.log("Menu:", repo);
  };

  return (
    <div className="min-h-screen bg-[#fafafa]">
      <SectionContainer>
        {/* Header with modern spacing */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-black mb-2" style={{ letterSpacing: '-0.5px' }}>Your Library</h1>
            <p className="text-sm sm:text-base text-black/50 font-normal">Deploy your GitHub repositories with one click</p>
          </div>
          <button
            onClick={() => setShowManualRepoModal(true)}
            className="inline-flex items-center justify-center gap-2 text-white font-medium transition-all duration-300 bg-black hover:bg-gray-900 rounded-full px-5 py-2.5 hover:shadow-md w-full sm:w-auto"
          >
            {generateIcon('git%20pull-171-1658431404.png', 20, 'white')}
            Add Repository
          </button>
        </div>

        {/* GitHub App Installation Pending Banner */}
        {pendingGithubAppUrl && (
          <div className="mb-6 bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-2xl p-5 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="p-3 bg-blue-100 rounded-full">
                {generateIcon('https://upload.wikimedia.org/wikipedia/commons/9/91/Octicons-mark-github.svg', 24, '#2563eb', {}, true)}
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900 mb-1">
                  Complete GitHub App Installation
                </h3>
                <p className="text-sm text-gray-600">
                  Click the button to install the Oblien GitHub App and access your repositories
                </p>
              </div>
            </div>
            <button
              onClick={handleContinueToGithubApp}
              className="inline-flex items-center gap-2 px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl transition-all duration-200 shadow-md hover:shadow-lg"
            >
              Continue to GitHub App
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
              </svg>
            </button>
          </div>
        )}

        {loadingAccounts && (
          <>
            <OwnerSelectorSkeleton />
            <RepositoryFiltersSkeleton />
            <RepositoryListSkeleton count={6} />
          </>
        )}

        {!isGithubConnected && !loadingAccounts && (
          <GithubConnectionPrompt
            onConnect={() => handleConnectGithub(checkGithubConnection, showToast, setGithubLoading)}
            loading={githubLoading}
            onAddManual={(url) => {
              if (url) {
                handleManualRepoDeploy(url);
              } else {
                setShowManualRepoModal(true);
              }
            }}
          />
        )}

        {isGithubConnected && !loadingAccounts && (
          <>
            <OwnerSelector
              accounts={accounts}
              selectedOwner={selectedOwner}
              onSelectOwner={setSelectedOwner}
              onRefresh={checkGithubConnection}
              showToast={showToast}
            />

            <RepositoryFilters
              searchTerm={searchTerm}
              onSearchChange={setSearchTerm}
              visibilityFilter={visibilityFilter}
              onVisibilityChange={setVisibilityFilter}
              sortBy={sortBy}
              onSortChange={setSortBy}
              viewMode={viewMode}
              onViewModeChange={setViewMode}
            />

            {loadingRepos ? (
              <RepositoryListSkeleton count={6} />
            ) : (
              <RepositoryList
                repositories={filteredAndSortedRepos}
                onDeploy={handleDeploy}
                viewMode={viewMode}
                onEditWithBlurs={handleEditWithBlurs}
                onMenu={handleMenu}
              />
            )}
          </>
        )}
      </SectionContainer>

      <AddRepositoryModal
        isOpen={showManualRepoModal}
        onClose={() => setShowManualRepoModal(false)}
        onSubmit={handleManualRepoDeploy}
      />
    </div>
  );
};

export default DeploymentDashboard;