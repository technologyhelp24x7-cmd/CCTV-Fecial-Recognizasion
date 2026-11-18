import {
  Activity,
  Camera,
  Clock,
  Cpu,
  FileBarChart2,
  Film,
  LayoutDashboard,
  ScrollText,
  Settings,
  ShieldAlert,
  UserCheck,
  Users,
  X,
} from 'lucide-react';
import type { NavModuleId } from '../../shared/types.ts';

export interface NavItemConfig {
  id: NavModuleId;
  label: string;
  section: 'Operations' | 'Intelligence & Governance' | 'Compliance & System';
  icon: typeof LayoutDashboard;
}

export const NAV_MODULES: NavItemConfig[] = [
  { id: 'dashboard', label: 'Dashboard', section: 'Operations', icon: LayoutDashboard },
  { id: 'video-library', label: 'CCTV Video Library', section: 'Operations', icon: Film },
  { id: 'camera-management', label: 'Camera Management', section: 'Operations', icon: Camera },
  { id: 'video-timeline', label: 'Video Timeline', section: 'Operations', icon: Clock },
  { id: 'person-gallery', label: 'Person Gallery', section: 'Intelligence & Governance', icon: Users },
  { id: 'person-profiles', label: 'Person Profiles', section: 'Intelligence & Governance', icon: UserCheck },
  { id: 'ai-detection', label: 'AI Detection', section: 'Intelligence & Governance', icon: Cpu },
  { id: 'watchlist-review', label: 'Watchlist Review', section: 'Intelligence & Governance', icon: ShieldAlert },
  { id: 'reports', label: 'Reports', section: 'Compliance & System', icon: FileBarChart2 },
  { id: 'audit-logs', label: 'Security & Audit Logs', section: 'Compliance & System', icon: ScrollText },
  { id: 'settings', label: 'Settings', section: 'Compliance & System', icon: Settings },
];

interface SidebarProps {
  activeModule: NavModuleId;
  onSelectModule: (id: NavModuleId) => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  pendingReviewsCount: number;
}

export function Sidebar({
  activeModule,
  onSelectModule,
  mobileOpen,
  onCloseMobile,
  pendingReviewsCount,
}: SidebarProps) {
  const sections: Array<NavItemConfig['section']> = [
    'Operations',
    'Intelligence & Governance',
    'Compliance & System',
  ];

  const navContent = (
    <div className="flex h-full flex-col bg-white dark:bg-[#0F141F] border-r border-slate-200 dark:border-slate-800/90">
      <div className="flex h-16 items-center justify-between px-5 border-b border-slate-200 dark:border-slate-800/90">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-blue-600 text-white">
            <Activity className="h-4 w-4" aria-hidden="true" />
          </div>
          <span className="font-display text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap truncate">
            LumaFlux Intelligence
          </span>
        </div>
        <button
          type="button"
          onClick={onCloseMobile}
          className="lg:hidden rounded-md p-1.5 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
          aria-label="Close navigation menu"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-6" aria-label="Main modules">
        {sections.map((section) => {
          const items = NAV_MODULES.filter((item) => item.section === section);
          return (
            <div key={section}>
              <div className="px-3 mb-2 text-xs font-medium text-slate-500 dark:text-slate-400">
                {section}
              </div>
              <ul className="space-y-0.5">
                {items.map((item) => {
                  const Icon = item.icon;
                  const isActive = activeModule === item.id;
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => {
                          onSelectModule(item.id);
                          onCloseMobile();
                        }}
                        className={`w-full flex items-center justify-between gap-2.5 px-3 py-2 rounded-md text-sm font-medium transition-colors whitespace-nowrap ${
                          isActive
                            ? 'bg-blue-600/10 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300'
                            : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100 dark:text-slate-300 dark:hover:text-white dark:hover:bg-slate-800/60'
                        }`}
                      >
                        <span className="flex items-center gap-2.5 min-w-0">
                          <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                          <span className="truncate">{item.label}</span>
                        </span>
                        {item.id === 'watchlist-review' && pendingReviewsCount > 0 && (
                          <span className="font-mono text-xs tabular-nums text-amber-600 dark:text-amber-400">
                            {pendingReviewsCount}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>

      <div className="px-4 py-3 border-t border-slate-200 dark:border-slate-800/90 text-xs text-slate-500 dark:text-slate-400">
        <div className="flex items-center justify-between">
          <span>Desktop Foundation</span>
          <span className="font-mono tabular-nums">Stage 1</span>
        </div>
      </div>
    </div>
  );

  return (
    <>
      <aside className="hidden lg:block w-[260px] shrink-0 h-screen sticky top-0">
        {navContent}
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-950/60"
            onClick={onCloseMobile}
            aria-hidden="true"
          />
          <aside className="relative z-10 w-[260px] max-w-[85vw] h-full">
            {navContent}
          </aside>
        </div>
      )}
    </>
  );
}
