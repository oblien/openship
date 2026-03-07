'use client';

import React from 'react';
import Link from 'next/link';
import { 
  Rocket, 
  Bot, 
  CreditCard, 
  Key, 
  Box, 
  Search,
  FolderPlus,
  ChevronRight,
  Sparkles
} from 'lucide-react';
import { useI18n } from '@/components/i18n-provider';

interface QuickLinkItem {
  title: string;
  description: string;
  href: string;
  icon: React.ReactNode;
  color: string;
  bgColor: string;
}

const QuickLinks: React.FC = () => {
  const { t } = useI18n();
  const quickLinks = t.dashboard.quickLinks;

  const links: QuickLinkItem[] = [
    {
      title: quickLinks.deployProject.title,
      description: quickLinks.deployProject.description,
      href: '/library',
      icon: <Rocket className="w-5 h-5" />,
      color: '#f59e0b',
      bgColor: 'rgba(245, 158, 11, 0.1)',
    },
    {
      title: quickLinks.projects.title,
      description: quickLinks.projects.description,
      href: '/projects',
      icon: <FolderPlus className="w-5 h-5" />,
      color: '#8b5cf6',
      bgColor: 'rgba(139, 92, 246, 0.1)',
    },
    {
      title: quickLinks.deployments.title,
      description: quickLinks.deployments.description,
      href: '/deployments',
      icon: <Box className="w-5 h-5" />,
      color: '#06b6d4',
      bgColor: 'rgba(6, 182, 212, 0.1)',
    },
    {
      title: quickLinks.settings.title,
      description: quickLinks.settings.description,
      href: '/settings',
      icon: <Key className="w-5 h-5" />,
      color: '#3b82f6',
      bgColor: 'rgba(59, 130, 246, 0.1)',
    },
    {
      title: quickLinks.domains.title,
      description: quickLinks.domains.description,
      href: '/domains',
      icon: <Search className="w-5 h-5" />,
      color: '#ec4899',
      bgColor: 'rgba(236, 72, 153, 0.1)',
    },
    {
      title: quickLinks.billing.title,
      description: quickLinks.billing.description,
      href: '/billing',
      icon: <CreditCard className="w-5 h-5" />,
      color: '#059669',
      bgColor: 'rgba(5, 150, 105, 0.1)',
    },
  ];

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-6">
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-primary/10 rounded-xl flex items-center justify-center">
            <Sparkles className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h3 className="font-semibold text-foreground">{quickLinks.title}</h3>
            <p className="text-xs text-muted-foreground">{quickLinks.subtitle}</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {links.map((link, index) => (
          <Link
            key={index}
            href={link.href}
            className="group flex flex-col items-center p-4 rounded-xl border border-border/50 hover:border-border hover:shadow-sm transition-all duration-300 bg-card"
          >
            <div 
              className="w-11 h-11 rounded-xl flex items-center justify-center mb-3 transition-transform group-hover:scale-110"
              style={{ backgroundColor: link.bgColor }}
            >
              <div style={{ color: link.color }}>{link.icon}</div>
            </div>
            <span className="text-sm font-medium text-foreground text-center mb-0.5">{link.title}</span>
            <span className="text-xs text-muted-foreground text-center">{link.description}</span>
          </Link>
        ))}
      </div>
    </div>
  );
};

export default QuickLinks;

