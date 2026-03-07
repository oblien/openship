import React, { useState } from "react";
import { ChevronDown, Plus, Github } from "lucide-react";
import { handleConnectGithub } from "@/utils/github";

interface Account {
  login: string;
  avatar_url: string;
  type: "User" | "Organization";
  name?: string;
}

interface OwnerSelectorProps {
  accounts: Account[];
  selectedOwner: string;
  onSelectOwner: (login: string) => void;
  onRefresh: () => void;
  showToast: (message: string, type: "success" | "error") => void;
}

const OwnerSelector: React.FC<OwnerSelectorProps> = ({
  accounts,
  selectedOwner,
  onSelectOwner,
  onRefresh,
  showToast,
}) => {
  const [showAll, setShowAll] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const visibleAccounts = showAll ? accounts : accounts.slice(0, 6);

  const handleAddAccount = async () => {
    await handleConnectGithub(onRefresh, showToast, setIsConnecting);
  };

  return (
    <div className="mb-8">
      <div>
        <div className="flex flex-wrap gap-2">
          {visibleAccounts.map((account) => (
            <button
              key={account.login}
              type="button"
              onClick={() => onSelectOwner(account.login)}
              className="group relative rounded-full flex px-3 py-2 items-center gap-2 transition-all duration-200"
              style={{
                backgroundColor: selectedOwner === account.login ? '#eee' : 'white',
                border: selectedOwner === account.login ? '1px solid #eee' : '1px solid #eee',
              }}
            >
              <img
                src={account.avatar_url}
                alt={account.login}
                className="rounded-full"
                style={{
                  width: '25px',
                  height: '25px',
                }}
              />
              <span 
                className="text-sm font-medium"
                style={{ color: '#000' }}
              >
                {account.login}
              </span>
              {account.type === "Organization" && (
                <span
                  className="text-[9px] px-1.5 py-0.5 rounded font-medium uppercase"
                  style={{
                    backgroundColor: '#f3f4f6',
                    color: '#6b7280',
                  }}
                >
                  Org
                </span>
              )}
            </button>
          ))}
          
          {/* Add Account Button */}
          <button
            type="button"
            onClick={handleAddAccount}
            disabled={isConnecting}
            className="group relative rounded-full flex px-3 py-2 items-center gap-2 transition-all duration-200 hover:shadow-md"
            style={{
              backgroundColor: isConnecting ? '#f3f4f6' : 'white',
              border: '1px solid #e5e7eb',
              borderStyle: 'dashed',
            }}
            onMouseEnter={(e) => {
              if (!isConnecting) {
                e.currentTarget.style.backgroundColor = '#f8fafc';
                e.currentTarget.style.borderColor = '#3b82f6';
              }
            }}
            onMouseLeave={(e) => {
              if (!isConnecting) {
                e.currentTarget.style.backgroundColor = 'white';
                e.currentTarget.style.borderColor = '#e5e7eb';
              }
            }}
          >
            <div
              className="rounded-full flex items-center justify-center"
              style={{
                width: '25px',
                height: '25px',
                backgroundColor: isConnecting ? '#d1d5db' : '#f3f4f6',
              }}
            >
              {isConnecting ? (
                <div className="animate-spin rounded-full h-3 w-3 border border-gray-400 border-t-transparent"></div>
              ) : (
                <Plus className="w-3 h-3 text-gray-500" />
              )}
            </div>
            <span 
              className="text-sm font-medium flex items-center gap-1 mr-2"
              style={{ color: isConnecting ? '#9ca3af' : '#6b7280' }}
            >
              {isConnecting ? 'Connecting...' : 'Add Account'}
            </span>
          </button>
        </div>
        {accounts.length > 6 && (
          <button
            type="button"
            onClick={() => setShowAll(!showAll)}
            className="mt-3 text-xs font-medium transition-colors flex items-center gap-1"
            style={{ color: '#6b7280' }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = '#000';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = '#6b7280';
            }}
          >
            {showAll ? "Show Less" : `Show ${accounts.length - 6} More`}
            <ChevronDown
              className={`w-3 h-3 transition-transform ${
                showAll ? "rotate-180" : ""
              }`}
            />
          </button>
        )}
      </div>
    </div>
  );
};

export default OwnerSelector;
