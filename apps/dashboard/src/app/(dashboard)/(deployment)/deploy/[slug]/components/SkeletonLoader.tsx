import { PageContainer } from "@/components/ui/PageContainer";

const Shimmer = ({ className }: { className?: string }) => (
  <div className={`bg-muted animate-pulse rounded-lg ${className ?? ""}`} />
);

const SkeletonLoader = () => (
  <PageContainer>
      <div className="grid lg:grid-cols-[1fr_340px] gap-6">
        {/* Main column */}
        <div className="space-y-5">
          {/* Project Settings */}
          <div className="bg-card rounded-2xl border border-border/50 p-5 space-y-4">
            <div className="flex items-center gap-3">
              <Shimmer className="w-8 h-8 rounded-lg" />
              <Shimmer className="h-5 w-32" />
            </div>
            <Shimmer className="h-10 rounded-xl" />
            <div className="grid grid-cols-3 gap-3">
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <Shimmer key={i} className="h-14 rounded-lg" />
              ))}
            </div>
            <Shimmer className="h-10 rounded-xl" />
          </div>

          {/* Build Settings */}
          <div className="bg-card rounded-2xl border border-border/50 p-5 space-y-4">
            <div className="flex items-center gap-3">
              <Shimmer className="w-8 h-8 rounded-lg" />
              <Shimmer className="h-5 w-28" />
            </div>
            {[1, 2, 3].map((i) => (
              <div key={i}>
                <Shimmer className="h-4 w-24 mb-2" />
                <Shimmer className="h-10 rounded-xl" />
              </div>
            ))}
          </div>

          {/* Environment Variables */}
          <div className="bg-card rounded-2xl border border-border/50 p-5 space-y-4">
            <div className="flex items-center gap-3">
              <Shimmer className="w-8 h-8 rounded-lg" />
              <Shimmer className="h-5 w-40" />
            </div>
            {[1, 2].map((i) => (
              <div key={i} className="flex gap-3">
                <Shimmer className="flex-1 h-10 rounded-xl" />
                <Shimmer className="flex-1 h-10 rounded-xl" />
                <Shimmer className="w-10 h-10 rounded-xl" />
              </div>
            ))}
          </div>

          {/* Project Name */}
          <div className="bg-card rounded-2xl border border-border/50 p-5 space-y-4">
            <Shimmer className="h-4 w-24" />
            <Shimmer className="h-10 rounded-xl" />
            <Shimmer className="h-4 w-56" />
          </div>
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          <div className="bg-card rounded-2xl border border-border/50 p-4">
            <div className="flex items-center gap-3">
              <Shimmer className="w-8 h-8 rounded-lg" />
              <div className="flex-1 space-y-1.5">
                <Shimmer className="h-4 w-32" />
                <Shimmer className="h-3 w-20" />
              </div>
            </div>
          </div>
          <div className="bg-card rounded-2xl border border-border/50 p-4 space-y-3">
            <Shimmer className="h-4 w-16" />
            <Shimmer className="h-9 rounded-xl" />
          </div>
          <Shimmer className="h-10 rounded-xl" />
        </div>
      </div>
  </PageContainer>
);

export default SkeletonLoader;