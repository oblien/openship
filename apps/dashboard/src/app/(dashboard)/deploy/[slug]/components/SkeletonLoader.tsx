
// Skeleton Loading Component
const SkeletonLoader = () => (
    <div className="min-h-screen bg-[#fafafa]">
        <style jsx>{`
                @keyframes shimmer {
                    0% {
                        background-position: -200px 0;
                    }
                    100% {
                        background-position: calc(200px + 100%) 0;
                    }
                }
                .skeleton {
                    background: #f0f0f0;
                    background-image: linear-gradient(
                        90deg,
                        #f0f0f0 0px,
                        #e8e8e8 40px,
                        #f0f0f0 80px
                    );
                    background-size: 200px;
                    animation: shimmer 1.5s ease-in-out infinite;
                }
                .skeleton-light {
                    background: #f8f8f8;
                    background-image: linear-gradient(
                        90deg,
                        #f8f8f8 0px,
                        #f0f0f0 40px,
                        #f8f8f8 80px
                    );
                    background-size: 200px;
                    animation: shimmer 1.5s ease-in-out infinite;
                }
                .skeleton-button {
                    background: #f8f8f8;
                    background-image: linear-gradient(
                        90deg,
                        #f8f8f8 0px,
                        #f0f0f0 40px,
                        #f8f8f8 80px
                    );
                    background-size: 200px;
                    animation: shimmer 1.5s ease-in-out infinite;
                }
            `}</style>
        <div className="mx-auto md:px-12 py-8">
            <div className="grid lg:grid-cols-3 gap-6">
                {/* Main Configuration Skeleton */}
                <div className="lg:col-span-2 space-y-6">
                    {/* Project Settings Skeleton */}
                    <div className="bg-white rounded-2xl border border-black/5 overflow-hidden">
                        <div className="px-6 py-5 border-b border-black/5">
                            <div className="flex items-center gap-3 mb-4">
                                <div className="w-8 h-8 skeleton rounded-lg"></div>
                                <div className="h-6 skeleton rounded-md w-32"></div>
                            </div>
                            <div className="h-4 skeleton rounded w-3/4"></div>
                        </div>
                        <div className="p-6 space-y-6">
                            {/* Project Name Field */}
                            <div>
                                <div className="h-4 skeleton rounded w-24 mb-2"></div>
                                <div className="h-12 skeleton-light rounded-xl"></div>
                            </div>
                            {/* Framework Selection */}
                            <div>
                                <div className="h-4 skeleton rounded w-20 mb-3"></div>
                                <div className="grid grid-cols-3 gap-3">
                                    {[1, 2, 3, 4, 5, 6].map((i) => (
                                        <div key={i} className="h-16 skeleton-light rounded-xl"></div>
                                    ))}
                                </div>
                            </div>
                            {/* Branch Selection */}
                            <div>
                                <div className="h-4 skeleton rounded w-16 mb-2"></div>
                                <div className="h-12 skeleton-light rounded-xl"></div>
                            </div>
                        </div>
                    </div>

                    {/* Build Settings Skeleton */}
                    <div className="bg-white rounded-2xl border border-black/5 overflow-hidden">
                        <div className="px-6 py-5 border-b border-black/5">
                            <div className="flex items-center gap-3 mb-4">
                                <div className="w-8 h-8 skeleton rounded-lg"></div>
                                <div className="h-6 skeleton rounded-md w-28"></div>
                            </div>
                            <div className="h-4 skeleton rounded w-2/3"></div>
                        </div>
                        <div className="p-6 space-y-6">
                            {/* Build Commands */}
                            {[1, 2, 3, 4].map((i) => (
                                <div key={i}>
                                    <div className="h-4 skeleton rounded w-32 mb-2"></div>
                                    <div className="h-12 skeleton-light rounded-xl"></div>
                                </div>
                            ))}
                            {/* Toggle Switch */}
                            <div className="flex items-center justify-between">
                                <div>
                                    <div className="h-4 skeleton rounded w-24 mb-1"></div>
                                    <div className="h-3 skeleton rounded w-40"></div>
                                </div>
                                <div className="w-12 h-6 skeleton rounded-full"></div>
                            </div>
                        </div>
                    </div>

                    {/* Environment Variables Skeleton */}
                    <div className="bg-white rounded-2xl border border-black/5 overflow-hidden">
                        <div className="px-6 py-5 border-b border-black/5">
                            <div className="flex items-center gap-3 mb-4">
                                <div className="w-8 h-8 skeleton rounded-lg"></div>
                                <div className="h-6 skeleton rounded-md w-40"></div>
                            </div>
                            <div className="h-4 skeleton rounded w-1/2"></div>
                        </div>
                        <div className="p-6">
                            <div className="space-y-3">
                                {[1, 2].map((i) => (
                                    <div key={i} className="flex gap-3">
                                        <div className="flex-1 h-12 skeleton-light rounded-xl"></div>
                                        <div className="flex-1 h-12 skeleton-light rounded-xl"></div>
                                        <div className="w-12 h-12 skeleton-light rounded-xl"></div>
                                    </div>
                                ))}
                            </div>
                            <div className="mt-4 h-10 skeleton-light rounded-xl w-32"></div>
                        </div>
                    </div>
                </div>

                {/* Sidebar Skeleton */}
                <div className="space-y-6">
                    {/* Repository Info Card */}
                    <div className="bg-white rounded-2xl border border-black/5 overflow-hidden">
                        <div className="p-6">
                            <div className="flex items-center gap-3 mb-4">
                                <div className="w-10 h-10 skeleton rounded-full"></div>
                                <div>
                                    <div className="h-5 skeleton rounded w-24 mb-1"></div>
                                    <div className="h-4 skeleton rounded w-16"></div>
                                </div>
                            </div>
                            <div className="space-y-3">
                                <div className="flex justify-between">
                                    <div className="h-4 skeleton rounded w-12"></div>
                                    <div className="h-4 skeleton rounded w-16"></div>
                                </div>
                                <div className="flex justify-between">
                                    <div className="h-4 skeleton rounded w-16"></div>
                                    <div className="h-4 skeleton rounded w-12"></div>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Domain Settings Card */}
                    <div className="bg-white rounded-2xl border border-black/5 overflow-hidden">
                        <div className="px-6 py-5 border-b border-black/5">
                            <div className="h-5 skeleton rounded w-20"></div>
                        </div>
                        <div className="p-6 space-y-4">
                            <div className="h-12 skeleton-light rounded-xl"></div>
                            <div className="h-12 skeleton-light rounded-xl"></div>
                            <div className="flex gap-2">
                                <div className="flex-1 h-10 skeleton-light rounded-lg"></div>
                                <div className="flex-1 h-10 skeleton-light rounded-lg"></div>
                            </div>
                        </div>
                    </div>

                    {/* Deploy Button */}
                    <div className="h-14 skeleton-button rounded-2xl"></div>
                </div>
            </div>
        </div>
    </div>
);

export default SkeletonLoader;