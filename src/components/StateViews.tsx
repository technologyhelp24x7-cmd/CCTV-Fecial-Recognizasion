import type { ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Clock, MinusCircle, XCircle } from 'lucide-react';

export function LoadingSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading data">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="h-12 rounded-md bg-slate-200/70 dark:bg-slate-800/60 animate-pulse"
        />
      ))}
    </div>
  );
}

export function ErrorBanner({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-red-300 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 px-4 py-3 text-sm text-red-800 dark:text-red-200"
    >
      <div className="flex items-center gap-2.5">
        <AlertCircle className="h-4 w-4 shrink-0 text-red-600 dark:text-red-400" aria-hidden="true" />
        <span>{message}</span>
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="px-3 py-1.5 rounded-md text-xs font-medium bg-red-600 text-white hover:bg-red-700 transition-colors whitespace-nowrap shrink-0"
        >
          Retry
        </button>
      )}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724] px-6 py-12 text-center">
      <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#161E2E] text-slate-500 dark:text-slate-400">
        {icon}
      </div>
      <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
        {title}
      </h3>
      <p className="mx-auto mt-1.5 max-w-md text-sm text-slate-600 dark:text-slate-400">
        {description}
      </p>
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}

type StatusTone = 'success' | 'warning' | 'danger' | 'neutral';

export function StatusText({
  label,
  tone = 'neutral',
}: {
  label: string;
  tone?: StatusTone;
}) {
  const Icon =
    tone === 'success'
      ? CheckCircle2
      : tone === 'warning'
        ? Clock
        : tone === 'danger'
          ? XCircle
          : MinusCircle;

  const colorClass =
    tone === 'success'
      ? 'text-emerald-700 dark:text-emerald-400'
      : tone === 'warning'
        ? 'text-amber-700 dark:text-amber-400'
        : tone === 'danger'
          ? 'text-red-700 dark:text-red-400'
          : 'text-slate-600 dark:text-slate-400';

  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap ${colorClass}`}>
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  destructive = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-md rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724] p-6 shadow-xl"
      >
        <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
          {title}
        </h3>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">{message}</p>
        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-md text-xs font-medium border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`px-4 py-2 rounded-md text-xs font-semibold text-white ${
              destructive ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
