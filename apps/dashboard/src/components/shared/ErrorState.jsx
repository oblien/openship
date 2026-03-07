/**
 * ErrorState Component - Reusable error display for different error scenarios
 * 
 * Usage:
 * 1. Use predefined error type:
 *    <ErrorState type="project-not-found" />
 * 
 * 2. Override specific fields:
 *    <ErrorState type="repo-not-found" error={{ message: "Custom title", details: "Custom subtitle" }} />
 * 
 * Available types: 'project-not-found', 'repo-not-found', 'access-denied'
 */

import generateIcon from "@/utils/icons";
import { useRouter } from "next/navigation";

const ERROR_CONFIGS = {
  'repo-not-found': {
    icon: 'face%20id%20fail-21-1691989601.png',
    iconColor: 'rgb(220, 38, 38)',
    iconBg: 'bg-red-100',
    headerBg: 'bg-red-50/50',
    borderColor: 'border-red-200/50',
    title: 'Repository Not Found',
    subtitle: 'We couldn\'t find the repository you\'re looking for.',
    commonIssues: [
      'Repository is private and you haven\'t granted access',
      'Repository name or owner is misspelled',
      'Repository has been deleted or moved',
      'Your GitHub connection has expired',
    ],
    solutions: [
      'Verify the repository exists and you have access to it',
      'Check your GitHub integration settings',
      'Try importing from your repositories list',
    ],
    actions: [
      {
        label: 'Back to Library',
        icon: 'arrow%20simple-80-1658238231.png',
        iconTransform: 'rotate-180',
        variant: 'secondary',
        path: '/library'
      },
      {
        label: 'Import Repository',
        icon: 'Add_LGqxXcmOqQRhUvQ8PQewxZcVl5jZqz0jVKFm.png',
        variant: 'primary',
        path: '/library?tab=import'
      }
    ]
  },
  'project-not-found': {
    icon: 'face%20id%20fail-21-1691989601.png',
    iconColor: 'rgb(220, 38, 38)',
    iconBg: 'bg-red-100',
    headerBg: 'bg-red-50/50',
    borderColor: 'border-red-200/50',
    title: 'Project Not Found',
    subtitle: 'The project you are looking for does not exist or has been deleted.',
    commonIssues: [
      'Project has been deleted',
      'You don\'t have access to this project',
      'The project URL is incorrect',
      'Your session may have expired',
    ],
    solutions: [
      'Check the project URL is correct',
      'Verify you have access to this project',
      'Try refreshing your browser',
      'Contact the project owner for access',
    ],
    actions: [
      {
        label: 'Back to Dashboard',
        icon: 'arrow%20simple-80-1658238231.png',
        iconTransform: 'rotate-180',
        variant: 'secondary',
        path: '/'
      },
      {
        label: 'Create New Project',
        icon: 'Add_LGqxXcmOqQRhUvQ8PQewxZcVl5jZqz0jVKFm.png',
        variant: 'primary',
        path: '/library?tab=import'
      }
    ]
  },
  'access-denied': {
    icon: 'lock-87-1661335286.png',
    iconColor: 'rgb(234, 88, 12)',
    iconBg: 'bg-orange-100',
    headerBg: 'bg-orange-50/50',
    borderColor: 'border-orange-200/50',
    title: 'Access Denied',
    subtitle: 'You don\'t have permission to access this resource.',
    commonIssues: [
      'You are not the project owner',
      'Your account doesn\'t have the required permissions',
      'The project is in a restricted workspace',
      'Your team membership has changed',
    ],
    solutions: [
      'Contact the project owner for access',
      'Check your team permissions',
      'Request access from your workspace admin',
    ],
    actions: [
      {
        label: 'Back to Dashboard',
        icon: 'arrow%20simple-80-1658238231.png',
        iconTransform: 'rotate-180',
        variant: 'secondary',
        path: '/dashboard'
      }
    ]
  }
};

const ErrorState = ({ error = {}, type = 'repo-not-found' }) => {
    const router = useRouter();
    
    // Use provided error config or fall back to type config
    const config = ERROR_CONFIGS[type] || ERROR_CONFIGS['repo-not-found'];
    
    // Allow overriding config with custom error object
    const title = error.message || config.title;
    const subtitle = error.details || config.subtitle;
    const commonIssues = error.commonIssues || config.commonIssues;
    const solutions = error.solutions || config.solutions;
    const actions = error.actions || config.actions;

    return (
        <div className="min-h-screen bg-[#fafafa]">
            <div className="mx-auto px-8 py-8 md:px-14">
                <div className="max-w-2xl mx-auto mt-10">
                    {/* Error Card */}
                    <div className={`bg-white rounded-[20px] border ${config.borderColor} shadow-sm overflow-hidden`}>
                        {/* Header with tint */}
                        <div className={`${config.headerBg} px-6 py-5 border-b ${config.borderColor}`}>
                            <div className="flex items-center gap-4">
                                <div className={`w-12 h-12 rounded-xl ${config.iconBg} flex items-center justify-center`}>
                                    {generateIcon(config.icon, 28, config.iconColor)}
                                </div>
                                <div>
                                    <h2 className="text-xl font-semibold text-black mb-1">
                                        {title}
                                    </h2>
                                    <p className="text-sm text-black/50">
                                        {subtitle}
                                    </p>
                                </div>
                            </div>
                        </div>

                        {/* Error Content */}
                        <div className="p-6 space-y-6">
                            {/* Common Issues */}
                            {commonIssues && commonIssues.length > 0 && (
                                <div>
                                    <h3 className="text-base font-semibold text-black mb-3">
                                        Common Issues
                                    </h3>
                                    <ul className="space-y-2">
                                        {commonIssues.map((issue, index) => (
                                            <li key={index} className="flex items-start gap-3 text-sm text-black/70">
                                                <span className="text-red-600 mt-0.5">•</span>
                                                <span>{issue}</span>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}

                            {/* What to Try */}
                            {solutions && solutions.length > 0 && (
                                <div className="bg-black/5 rounded-xl p-4 border border-black/10">
                                    <h3 className="text-base font-semibold text-black mb-3">
                                        What to Try
                                    </h3>
                                    <div className="space-y-2 text-sm text-black/70">
                                        {solutions.map((solution, index) => (
                                            <p key={index}>{index + 1}. {solution}</p>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Action Buttons */}
                            {actions && actions.length > 0 && (
                                <div className="flex gap-3 pt-2">
                                    {actions.map((action, index) => (
                                        <button
                                            key={index}
                                            onClick={() => router.push(action.path)}
                                            className={`flex-1 flex items-center justify-center gap-2 px-5 py-3 rounded-full text-sm font-medium transition-all ${
                                                action.variant === 'primary'
                                                    ? 'bg-black text-white hover:bg-gray-900 shadow-sm hover:shadow-md'
                                                    : 'bg-white border border-black/10 text-black hover:bg-black/5'
                                            }`}
                                        >
                                            {action.icon && generateIcon(
                                                action.icon, 
                                                18, 
                                                action.variant === 'primary' ? 'white' : 'currentColor', 
                                                action.iconTransform ? { transform: action.iconTransform === 'rotate-180' ? 'rotate(180deg)' : action.iconTransform } : {}
                                            )}
                                            <span>{action.label}</span>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Help Card */}
                    <div className="mt-6 bg-white rounded-[20px] border border-black/5 shadow-sm p-6">
                        <div className="flex items-start gap-4">
                            <div className="w-10 h-10 rounded-xl bg-indigo-50 flex items-center justify-center flex-shrink-0">
                                {generateIcon('help%20sign-50-1658435663.png', 24, 'rgb(79, 70, 229)')}
                            </div>
                            <div>
                                <h3 className="text-base font-semibold text-black mb-2">
                                    Need Help?
                                </h3>
                                <p className="text-sm text-black/70 mb-3">
                                    If you continue to experience issues, check our documentation or contact support.
                                </p>
                                <div className="flex gap-3">
                                    <a
                                        href="https://docs.oblien.com"
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-sm text-indigo-600 hover:text-indigo-700 font-medium"
                                    >
                                        View Documentation →
                                    </a>
                                    <a
                                        href="mailto:support@oblien.com"
                                        className="text-sm text-indigo-600 hover:text-indigo-700 font-medium"
                                    >
                                        Contact Support →
                                    </a>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
}

export default ErrorState;