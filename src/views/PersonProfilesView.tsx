import { useMemo, useState, type FormEvent } from 'react';
import { Plus, Trash2, UserCheck } from 'lucide-react';
import { api, formatTimestamp } from '../api/client.ts';
import { ConfirmDialog, EmptyState, ErrorBanner, LoadingSkeleton, StatusText } from '../components/StateViews.tsx';
import type { AuthorizationLevel, ConsentStatus, PersonProfileRecord, ProfileCategory } from '../../shared/types.ts';

interface PersonProfilesViewProps {
  profiles: PersonProfileRecord[];
  loading: boolean;
  error: string | null;
  onRefresh: () => Promise<void>;
}

export function PersonProfilesView({
  profiles,
  loading,
  error,
  onRefresh,
}: PersonProfilesViewProps) {
  const [categoryFilter, setCategoryFilter] = useState<'all' | 'authorized' | 'anonymous'>('all');
  const [showCreate, setShowCreate] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [category, setCategory] = useState<ProfileCategory>('authorized');
  const [authLevel, setAuthLevel] = useState<AuthorizationLevel>('visitor');
  const [consentStatus, setConsentStatus] = useState<ConsentStatus>('granted');
  const [department, setDepartment] = useState('Operations');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PersonProfileRecord | null>(null);

  const filtered = useMemo(() => {
    if (categoryFilter === 'all') return profiles;
    return profiles.filter((p) => p.category === categoryFilter);
  }, [profiles, categoryFilter]);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setActionError(null);
    try {
      await api.createProfile({
        display_name: displayName,
        category,
        authorization_level: authLevel,
        consent_status: consentStatus,
        department_or_zone: department,
        notes,
      });
      setDisplayName('');
      setNotes('');
      setShowCreate(false);
      await onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to create profile.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleConsentChange = async (profile: PersonProfileRecord, nextConsent: ConsentStatus) => {
    setActionError(null);
    try {
      const nextAuth: AuthorizationLevel =
        nextConsent !== 'granted' && profile.authorization_level === 'authorized'
          ? 'visitor'
          : profile.authorization_level;
      await api.updateProfile(profile.id, {
        consent_status: nextConsent,
        authorization_level: nextAuth,
      });
      await onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update consent status.');
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setActionError(null);
    try {
      await api.deleteProfile(deleteTarget.id);
      setDeleteTarget(null);
      await onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to delete profile.');
    }
  };

  if (loading && profiles.length === 0) return <LoadingSkeleton rows={5} />;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-xl font-semibold text-slate-900 dark:text-slate-100">
            Person Profiles
          </h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Consent-governed registry for authorized personnel and anonymous records. Biometric templates are disabled in Stage 1.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setShowCreate((prev) => !prev)}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white transition-colors whitespace-nowrap"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          <span>{showCreate ? 'Close Form' : 'New Profile'}</span>
        </button>
      </div>

      {(error || actionError) && (
        <ErrorBanner message={actionError || error || 'Profile error'} onRetry={onRefresh} />
      )}

      {showCreate && (
        <form
          onSubmit={handleCreate}
          className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724] p-6 space-y-4"
        >
          <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
            Register Consent-Governed Profile
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Display Label / Identifier
              </label>
              <input
                type="text"
                required
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="e.g. Facility Engineer #14 or Subject-Anon"
                className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Profile Category
              </label>
              <select
                value={category}
                onChange={(e) => {
                  const nextCat = e.target.value as ProfileCategory;
                  setCategory(nextCat);
                  if (nextCat === 'anonymous') {
                    setAuthLevel('anonymous');
                    setConsentStatus('pending');
                  } else {
                    setAuthLevel('authorized');
                  }
                }}
                className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
              >
                <option value="authorized">Authorized / Registered</option>
                <option value="anonymous">Anonymous Subject</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Authorization Level
              </label>
              <select
                value={authLevel}
                onChange={(e) => setAuthLevel(e.target.value as AuthorizationLevel)}
                className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
              >
                <option value="authorized">Authorized</option>
                <option value="visitor">Visitor</option>
                <option value="restricted">Restricted</option>
                <option value="anonymous">Anonymous</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Consent Status
              </label>
              <select
                value={consentStatus}
                onChange={(e) => setConsentStatus(e.target.value as ConsentStatus)}
                className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
              >
                <option value="granted">Granted</option>
                <option value="pending">Pending</option>
                <option value="revoked">Revoked</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Department or Zone
              </label>
              <input
                type="text"
                value={department}
                onChange={(e) => setDepartment(e.target.value)}
                className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Governance Notes
              </label>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Consent record reference or zone notes"
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
              {submitting ? 'Saving...' : 'Save Profile'}
            </button>
          </div>
        </form>
      )}

      <div className="flex items-center gap-1 p-1 w-fit rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724]">
        {(['all', 'authorized', 'anonymous'] as const).map((cat) => (
          <button
            key={cat}
            type="button"
            onClick={() => setCategoryFilter(cat)}
            className={`px-3 py-1.5 rounded text-xs font-medium capitalize transition-colors ${
              categoryFilter === cat
                ? 'bg-blue-600 text-white'
                : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<UserCheck className="h-5 w-5" />}
          title="No person profiles recorded"
          description="Create authorized or anonymous profile records with explicit consent tracking. Privacy policy blocks assigning authorized status without documented consent."
          action={
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className="px-4 py-2 rounded-md text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white"
            >
              Create First Profile
            </button>
          }
        />
      ) : (
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724] overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400">
                <th className="py-3 px-5 font-medium">Profile Code</th>
                <th className="py-3 px-4 font-medium">Label</th>
                <th className="py-3 px-4 font-medium">Category</th>
                <th className="py-3 px-4 font-medium">Authorization</th>
                <th className="py-3 px-4 font-medium">Consent</th>
                <th className="py-3 px-4 font-medium">Zone</th>
                <th className="py-3 px-4 font-medium">Updated</th>
                <th className="py-3 px-5 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
              {filtered.map((profile) => (
                <tr key={profile.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/30">
                  <td className="py-3 px-5 font-mono text-slate-900 dark:text-slate-100 whitespace-nowrap">
                    {profile.profile_code}
                  </td>
                  <td className="py-3 px-4 font-medium text-slate-900 dark:text-slate-100">
                    <div>{profile.display_name}</div>
                    {profile.notes && (
                      <div className="text-[11px] font-normal text-slate-500 dark:text-slate-400">
                        {profile.notes}
                      </div>
                    )}
                  </td>
                  <td className="py-3 px-4 capitalize text-slate-600 dark:text-slate-300">
                    {profile.category}
                  </td>
                  <td className="py-3 px-4 capitalize text-slate-700 dark:text-slate-200">
                    {profile.authorization_level}
                  </td>
                  <td className="py-3 px-4">
                    <StatusText
                      label={profile.consent_status}
                      tone={
                        profile.consent_status === 'granted'
                          ? 'success'
                          : profile.consent_status === 'revoked'
                            ? 'danger'
                            : 'warning'
                      }
                    />
                  </td>
                  <td className="py-3 px-4 text-slate-600 dark:text-slate-300">
                    {profile.department_or_zone}
                  </td>
                  <td className="py-3 px-4 font-mono tabular-nums text-slate-500 dark:text-slate-400 whitespace-nowrap">
                    {formatTimestamp(profile.updated_at)}
                  </td>
                  <td className="py-3 px-5 text-right whitespace-nowrap">
                    <div className="inline-flex items-center gap-2">
                      <select
                        aria-label={`Consent status for ${profile.display_name}`}
                        value={profile.consent_status}
                        onChange={(e) => handleConsentChange(profile, e.target.value as ConsentStatus)}
                        className="rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-2 py-1 text-xs text-slate-800 dark:text-slate-200"
                      >
                        <option value="granted">Granted</option>
                        <option value="pending">Pending</option>
                        <option value="revoked">Revoked</option>
                      </select>
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(profile)}
                        className="p-1.5 rounded hover:bg-red-100 dark:hover:bg-red-950/50 text-red-600 dark:text-red-400"
                        aria-label={`Delete profile ${profile.display_name}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Delete Person Profile"
        message={
          deleteTarget
            ? `Delete profile ${deleteTarget.profile_code} (${deleteTarget.display_name})? This action is recorded in the audit log.`
            : ''
        }
        confirmLabel="Delete Profile"
        destructive
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
