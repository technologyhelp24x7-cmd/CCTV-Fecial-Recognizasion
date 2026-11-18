import { Menu, Moon, Sun, Upload } from 'lucide-react';
import type { NavModuleId, ThemeMode } from '../../shared/types.ts';
import { NAV_MODULES } from './Sidebar.tsx';

interface TopBarProps {
  activeModule: NavModuleId;
  theme: ThemeMode;
  onToggleTheme: () => void;
  onOpenMobileMenu: () => void;
  onOpenImportModal: () => void;
}

export function TopBar({
  activeModule,
  theme,
  onToggleTheme,
  onOpenMobileMenu,
  onOpenImportModal,
}: TopBarProps) {
  const current = NAV_MODULES.find((m) => m.id === activeModule);

  return (
    <header className="sticky top-0 z-30 h-16 bg-white/95 dark:bg-[#0B0F17]/95 backdrop-blur-sm border-b border-slate-200 dark:border-slate-800/90 px-4 lg:px-8 flex items-center justify-between gap-6">
      <div className="flex items-center gap-3 min-w-0">
        <button
          type="button"
          onClick={onOpenMobileMenu}
          className="lg:hidden inline-flex items-center justify-center rounded-md p-2 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
          aria-label="Open navigation menu"
        >
          <Menu className="h-5 w-5" />
        </button>
        <div className="flex items-center gap-2 text-sm min-w-0">
          <span className="text-slate-500 dark:text-slate-400 whitespace-nowrap hidden sm:inline">
            {current?.section ?? 'Workspace'}
          </span>
          <span className="text-slate-400 dark:text-slate-600 hidden sm:inline" aria-hidden="true">
            /
          </span>
          <h1 className="font-display font-semibold text-slate-900 dark:text-slate-100 truncate">
            {current?.label ?? 'Dashboard'}
          </h1>
        </div>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        <button
          type="button"
          onClick={onToggleTheme}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs font-medium border border-slate-200 dark:border-slate-800 bg-slate-50 hover:bg-slate-100 text-slate-700 dark:bg-[#131926] dark:hover:bg-slate-800 dark:text-slate-200 transition-colors whitespace-nowrap shrink-0"
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
        >
          {theme === 'dark' ? (
            <>
              <Sun className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Light Theme</span>
            </>
          ) : (
            <>
              <Moon className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Dark Theme</span>
            </>
          )}
        </button>

        <button
          type="button"
          onClick={onOpenImportModal}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white transition-colors whitespace-nowrap shrink-0"
        >
          <Upload className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Import Video</span>
        </button>
      </div>
    </header>
  );
}
