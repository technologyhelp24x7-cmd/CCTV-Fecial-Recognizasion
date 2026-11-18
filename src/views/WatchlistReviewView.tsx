import { useMemo, useState, type FormEvent } from 'react';
import { Plus, ShieldAlert } from 'lucide-react';
import { api, formatTimestamp } from '../api/client.ts';
import { EmptyState, ErrorBanner, LoadingSkeleton, StatusText } from '../components/StateViews.tsx';
import type {
  PersonProfileRecord,
  ReviewPriority,
  ReviewStatus,
  VideoFileRecord,
  WatchlistReviewRecord,
} from '../../shared/types.ts';

interface WatchlistReviewViewProps {
  reviews: WatchlistReviewRecord[];
  profiles: PersonProfileRecord[];
  videos: VideoFileRecord[];
  loading: boolean;
  error: string | null;
  onRefresh: () => Promise<void>;
}

export function WatchlistReviewView({
  reviews,
  profiles,
  videos,
  loading,
  error,
  onRefresh,
}: WatchlistReviewViewProps) {
  const [statusFilter, setStatusFilter] = useState<'all' | ReviewStatus>('all');
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<ReviewPriority>('medium');
  const [reason, setReason] = useState('');
  const [profileId, setProfileId] = useState('');
  const [videoId, setVideoId] = useState('');
  const [assignedTo, setAssignedTo] = useState('Security Operator');
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    if (statusFilter === 'all') return reviews;
    return reviews.filter((r) => r.status === statusFilter);
  }, [reviews, statusFilter]);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setActionError(null);
    try {
      await api.createWatchlistReview({
        title,
        priority,
        reason,
        profile_id: profileId || null,
        video_file_id: videoId || null,
        assigned_to: assignedTo,
      });
      setTitle('');
      setReason('');
      setShowCreate(false);
      await onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to open review case.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleStatusChange = async (review: WatchlistReviewRecord, nextStatus: ReviewStatus) => {
    setActionError(null);
    try {
      await api.updateWatchlistReview(review.id, { status: nextStatus });
      await onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update review status.');
    }
  };

  if (loading && reviews.length === 0) return <LoadingSkeleton rows={4} />;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-xl font-semibold text-slate-900 dark:text-slate-100">
            Watchlist Review
          </h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Human-in-the-loop security review queue with full operator accountability and audit logging.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setShowCreate((prev) => !prev)}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white transition-colors whitespace-nowrap"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          <span>{showCreate ? 'Close Form' : 'Open Review Case'}</span>
        </button>
      </div>

      {(error || actionError) && (
        <ErrorBanner message={actionError || error || 'Watchlist review error'} onRetry={onRefresh} />
      )}

      {showCreate && (
        <form
          onSubmit={handleCreate}
          className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724] p-6 space-y-4"
        >
          <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
            Create Human Security Review Case
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Case Title
              </label>
              <input
                type="text"
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Gate 3 After-Hours Access Verification"
                className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Priority
              </label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as ReviewPriority)}
                className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Linked Profile (Optional)
              </label>
              <select
                value={profileId}
                onChange={(e) => setProfileId(e.target.value)}
                className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
              >
                <option value="">None</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.profile_code} · {p.display_name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Linked Video (Optional)
              </label>
              <select
                value={videoId}
                onChange={(e) => setVideoId(e.target.value)}
                className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
              >
                <option value="">None</option>
                {videos.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.original_name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Assigned Reviewer
              </label>
              <input
                type="text"
                value={assignedTo}
                onChange={(e) => setAssignedTo(e.target.value)}
                className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
              />
            </div>

            <div className="md:col-span-3">
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Justification / Review Reason
              </label>
              <textarea
                required
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Document specific operational reason requiring human review..."
                className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
              />
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => setShowCreate(false)}
              className="px-4 py-2 rounded-md text-xs font-medium border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 rounded-md text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
            >
              {submitting ? 'Creating...' : 'Create Review Case'}
            </button>
          </div>
        </form>
      )}

      <div className="flex flex-wrap items-center gap-1 p-1 w-fit rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724]">
        {(['all', 'pending', 'in_review', 'approved', 'dismissed', 'escalated'] as const).map((st) => (
          <button
            key={st}
            type="button"
            onClick={() => setStatusFilter(st)}
            className={`px-3 py-1.5 rounded text-xs font-medium capitalize transition-colors ${
              statusFilter === st
                ? 'bg-blue-600 text-white'
                : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
            }`}
          >
            {st.replace('_', ' ')}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<ShieldAlert className="h-5 w-5" />}
          title="No watchlist review cases in queue"
          description="Pending human-review cases for restricted zone access or manual footage escalations appear here with full audit history."
          action={
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className="px-4 py-2 rounded-md text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white"
            >
              Open Review Case
            </button>
          }
        />
      ) : (
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724] overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400">
                <th className="py-3 px-5 font-medium">Case</th>
                <th className="py-3 px-4 font-medium">Priority</th>
                <th className="py-3 px-4 font-medium">Linked Context</th>
                <th className="py-3 px-4 font-medium">Assignee</th>
                <th className="py-3 px-4 font-medium">Status</th>
                <th className="py-3 px-4 font-medium">Updated</th>
                <th className="py-3 px-5 font-medium text-right">Decision</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
              {filtered.map((item) => (
                <tr key={item.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/30">
                  <td className="py-3 px-5 max-w-xs">
                    <div className="font-medium text-slate-900 dark:text-slate-100">{item.title}</div>
                    <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400 line-clamp-2">
                      {item.reason}
                    </div>
                  </td>
                  <td className="py-3 px-4">
                    <StatusText
                      label={item.priority}
                      tone={
                        item.priority === 'critical' || item.priority === 'high'
                          ? 'danger'
                          : item.priority === 'medium'
                            ? 'warning'
                            : 'neutral'
                      }
                    />
                  </td>
                  <td className="py-3 px-4 text-slate-600 dark:text-slate-300">
                    {item.profile_name || item.video_name || 'Standalone Case'}
                  </td>
                  <td className="py-3 px-4 text-slate-700 dark:text-slate-300">{item.assigned_to}</td>
                  <td className="py-3 px-4">
                    <StatusText
                      label={item.status.replace('_', ' ')}
                      tone={
                        item.status === 'approved'
                          ? 'success'
                          : item.status === 'escalated'
                            ? 'danger'
                            : item.status === 'dismissed'
                              ? 'neutral'
                              : 'warning'
                      }
                    />
                  </td>
                  <td className="py-3 px-4 font-mono tabular-nums text-slate-500 dark:text-slate-400 whitespace-nowrap">
                    {formatTimestamp(item.updated_at)}
                  </td>
                  <td className="py-3 px-5 text-right whitespace-nowrap">
                    <select
                      aria-label={`Status for ${item.title}`}
                      value={item.status}
                      onChange={(e) => handleStatusChange(item, e.target.value as ReviewStatus)}
                      className="rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-2 py-1 text-xs text-slate-800 dark:text-slate-200"
                    >
                      <option value="pending">Pending</option>
                      <option value="in_review">In Review</option>
                      <option value="approved">Approved</option>
                      <option value="dismissed">Dismissed</option>
                      <option value="escalated">Escalated</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
