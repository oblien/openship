import React, { useState } from "react";
import { Project } from "@/constants/mock";
import { TrendingUp, BarChart3, Activity, Rocket, CheckCircle2, Clock, Zap } from "lucide-react";
import { generateIcon } from "@/utils/icons";
import { SlidingToggle } from "@/components/ui/SlidingToggle";

interface ActivityChartProps {
  projects: Project[];
  numbers: any;
}

interface DayData {
  date: Date;
  label: string;
  count: number;
}

type ChartType = 'bar' | 'line' | 'area';

const ActivityChart: React.FC<ActivityChartProps> = ({ projects, numbers }) => {
  const [chartType, setChartType] = useState<ChartType>('area');

  // Generate last 7 days data using actual deployment analytics
  const getLast7DaysData = (): DayData[] => {
    const days: DayData[] = [];
    const today = new Date();
    
    // Create array for last 7 days
    for (let i = 6; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      days.push({
        date: date,
        label: date.toLocaleDateString('en-US', { weekday: 'short' }),
        count: 0
      });
    }
    
    // Map actual deployment data from numbers.daily_deployments
    if (numbers?.daily_deployments && Array.isArray(numbers.daily_deployments)) {
      numbers.daily_deployments.forEach((deployment: any) => {
        if (deployment?.date && typeof deployment.count !== 'undefined') {
          const deployDate = new Date(deployment.date);
          const dayIndex = days.findIndex(day => 
            day.date.toDateString() === deployDate.toDateString()
          );
          if (dayIndex !== -1) {
            days[dayIndex].count = parseInt(deployment.count) || 0;
          }
        }
      });
    }
    
    // Debug log
    console.log('Daily deployments data:', numbers?.daily_deployments);
    console.log('Processed days:', days);
    
    return days;
  };

  const data = getLast7DaysData();
  const maxCount = Math.max(...data.map(d => d.count), 1);
  const totalDeployments = numbers.total_deployments;
  const liveProjects = numbers.total_active_projects;
  
  // Calculate trend
  const recentDays = data.slice(-3).reduce((sum, d) => sum + d.count, 0);
  const olderDays = data.slice(0, 3).reduce((sum, d) => sum + d.count, 0);
  const trend = recentDays > olderDays ? 'up' : recentDays < olderDays ? 'down' : 'stable';
  const trendPercentage = olderDays > 0 ? Math.round(((recentDays - olderDays) / olderDays) * 100) : 0;

  const renderChart = () => {
    if (chartType === 'line') {
      const points = data.map((day, index) => {
        const height = maxCount > 0 ? (day.count / maxCount) * 100 : 0;
        const x = (index / (data.length - 1)) * 100;
        const y = 100 - (height || 0);
        return `${x},${y}`;
      }).join(' ');

      return (
        <svg className="w-full h-24" viewBox="0 0 100 100" preserveAspectRatio="none">
          <polyline
            points={points}
            fill="none"
            stroke="var(--th-on-50)"
            strokeWidth="2.5"
            vectorEffect="non-scaling-stroke"
          />
          {data.map((day, index) => {
            const height = maxCount > 0 ? (day.count / maxCount) * 100 : 0;
            const x = (index / (data.length - 1)) * 100;
            const y = 100 - (height || 0);
            const isToday = index === data.length - 1;
            
            return (
              <circle
                key={index}
                cx={x}
                cy={y}
                r="4"
                fill={isToday ? 'var(--th-btn-bg)' : day.count > 0 ? 'var(--th-on-30)' : 'var(--th-sf-06)'}
                stroke="var(--th-card-bg)"
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
        </svg>
      );
    }

    if (chartType === 'area') {
      const points = data.map((day, index) => {
        const height = maxCount > 0 ? (day.count / maxCount) * 100 : 0;
        const x = (index / (data.length - 1)) * 100;
        const y = 100 - (height || 0);
        return `${x},${y}`;
      }).join(' ');

      return (
        <svg className="w-full h-24" viewBox="0 0 100 100" preserveAspectRatio="none">
          <defs>
            <linearGradient id="areaGradient" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="var(--th-on-30)" stopOpacity="0.3" />
              <stop offset="100%" stopColor="var(--th-on-30)" stopOpacity="0.05" />
            </linearGradient>
          </defs>
          <polygon
            points={`0,100 ${points} 100,100`}
            fill="url(#areaGradient)"
          />
          <polyline
            points={points}
            fill="none"
            stroke="var(--th-on-50)"
            strokeWidth="2.5"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      );
    }

    // Default bar chart
    return (
      <div className="flex items-end justify-between gap-3 h-24">
        {data.map((day, index) => {
          const height = maxCount > 0 ? (day.count / maxCount) * 100 : 0;
          const isToday = index === data.length - 1;
          
          return (
            <div key={index} className="flex-1 flex flex-col items-center gap-2">
              <div className="w-full relative group h-24 flex items-end">
                {/* Tooltip */}
                {day.count > 0 && (
                  <div className="absolute -top-10 left-1/2 transform -translate-x-1/2 bg-primary text-primary-foreground text-xs px-3 py-1.5 rounded-lg shadow-lg opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap font-medium z-10">
                    {day.count} {day.count === 1 ? 'deployment' : 'deployments'}
                  </div>
                )}
                
                {/* Bar */}
                <div
                  className={`w-full rounded-t-xl transition-all duration-300 ${
                    isToday 
                      ? 'bg-primary shadow-lg shadow-primary/30' 
                      : day.count > 0 
                        ? 'bg-muted-foreground/40 group-hover:bg-muted-foreground/60' 
                        : 'bg-muted/60'
                  }`}
                  style={{ height: height > 5 ? `${height}%` : height > 0 ? '8%' : '0%' }}
                ></div>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="bg-card rounded-xl border border-border/50 flex flex-col overflow-hidden">
      {/* Compact Header */}
      <div className="relative bg-muted/40 px-5 py-4 border-b border-border/50">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-muted flex items-center justify-center">
              {generateIcon('space%20rocket-85-1687505546.png', 20, 'var(--th-text-muted)')}
            </div>
            <div>
              <h3 className="text-sm font-medium text-foreground/80">Activity</h3>
              <div className="flex items-baseline gap-2 mt-0.5">
                <p className="text-xl font-semibold text-foreground">{totalDeployments}</p>
                <span className="text-xs text-muted-foreground">this week</span>
              </div>
            </div>
          </div>
          
          {/* Chart Type Selector */}
          <SlidingToggle
            options={[
              {
                value: 'bar',
                icon: <BarChart3 className="w-4 h-4" />,
              },
              {
                value: 'area',
                icon: <TrendingUp className="w-4 h-4" />,
              },
            ]}
            value={chartType}
            onChange={(value) => setChartType(value as ChartType)}
            variant="rounded"
            selectedBg="bg-primary"
            selectedTextColor="text-primary-foreground"
            unselectedTextColor="text-muted-foreground"
            backgroundColor="bg-card"
            size="md"
          />
        </div>
      </div>

      {/* Chart Area - Compact */}
      <div className="px-5 py-4">
        <div className="mb-3">
          {renderChart()}
        </div>

        {/* Day Labels */}
        <div className="flex items-center justify-between gap-2">
          {data.map((day, index) => {
            const isToday = index === data.length - 1;
            return (
              <div key={index} className="flex-1 text-center">
                <span className={`text-xs font-medium ${isToday ? 'text-foreground' : 'text-muted-foreground'}`}>
                  {day.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default ActivityChart;

