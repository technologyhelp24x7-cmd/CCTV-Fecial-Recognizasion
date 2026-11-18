import { useEffect, useState, type FormEvent } from 'react';
import { FolderOpen, Save, Trash } from 'lucide-react';
import { api, isTauriDesktop, pickDesktopDirectory } from '../api/client.ts';
import { ErrorBanner, LoadingSkeleton } from '../components/StateViews.tsx';
import type { AppSettingsMap, ThemeMode } from '../../shared/types.ts';

interface SettingsViewProps {
  settings: AppSettingsMap | null;
  loading: boolean;
  error: string | null;
  theme: ThemeMode;
  onChangeTheme: (theme: ThemeMode) => void;
  onRefresh: () => Promise<void>;
}

export function SettingsView({
  settings,
  loading,
  error,
  theme,
  onChangeTheme,
  onRefresh,
}: SettingsViewProps) {
  const [storageDir, setStorageDir] = useState('');
  const [thumbDir, setThumbDir] = useState('');
  const [quotaGb, setQuotaGb] = useState('250');
  const [retentionDays, setRetentionDays] = useState('30');
  const [privacyBlur, setPrivacyBlur] = useState('true');
  const [privacyMaskMode, setPrivacyMaskMode] = useState('blur');
  const [detThreshold, setDetThreshold] = useState('0.45');
  const [detSampleFps, setDetSampleFps] = useState('2.0');
  const [requireConsent, setRequireConsent] = useState('true');
  const [logLevel, setLogLevel] = useState('INFO');
  const [saving, setSaving] = useState(false);
  const [purging, setPurging] = useState(false);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!settings) return;
    setStorageDir(settings.storage_directory || '');
    setThumbDir(settings.thumbnail_directory || '');
    setQuotaGb(settings.max_storage_quota_gb || '250');
    setRetentionDays(settings.default_retention_days || '30');
    setPrivacyBlur(settings.privacy_blur_default || 'true');
    setPrivacyMaskMode(settings.privacy_mask_mode || 'blur');
    setDetThreshold(settings.detection_confidence_threshold || '0.45');
    setDetSampleFps(settings.detection_sample_fps || '2.0');
    setRequireConsent(settings.require_consent_for_profiles || 'true');
    setLogLevel(settings.log_level || 'INFO');
  }, [settings]);

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSaveError(null);
    setSavedNotice(null);
    try {
      await api.updateSettings({
        storage_directory: storageDir.trim(),
        thumbnail_directory: thumbDir.trim(),
        max_storage_quota_gb: quotaGb.trim(),
        default_retention_days: retentionDays.trim(),
        privacy_blur_default: privacyBlur,
        privacy_mask_mode: privacyMaskMode,
        detection_confidence_threshold: detThreshold.trim(),
        detection_sample_fps: detSampleFps.trim(),
        require_consent_for_profiles: requireConsent,
        log_level: logLevel,
        theme,
      });
      await onRefresh();
      setSavedNotice('Local settings saved to SQLite and audited.');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save settings.');
    } finally {
      setSaving(false);
    }
  };

  const handleEnforceRetention = async () => {
    setPurging(true);
    setSaveError(null);
    setSavedNotice(null);
    try {
      const res = await api.enforceRetention();
      setSavedNotice(
        `Retention sweep completed: removed ${res.expired_videos_deleted} expired video(s) and ${res.orphaned_events_purged} dismissed event(s).`
      );
      await onRefresh();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to run retention sweep.');
    } finally {
      setPurging(false);
    }
  };

  if (loading && !settings) return <LoadingSkeleton rows={6} />;

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h2 className="font-display text-xl font-semibold text-slate-900 dark:text-slate-100">
          Settings
        </h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Configure local storage vaults, retention policies, AI detection thresholds, privacy masking, and appearance.
        </p>
      </div>

      {(error || saveError) && <ErrorBanner message={saveError || error || 'Settings error'} onRetry={onRefresh} />}

      {savedNotice && (
        <div className="rounded-md border border-emerald-300 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/30 px-4 py-3 text-xs text-emerald-800 dark:text-emerald-200">
          {savedNotice}
        </div>
      )}

      <form onSubmit={handleSave} className="space-y-6">
        <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724] p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
              Local Video Storage & Retention
            </h3>
            <button
              type="button"
              disabled={purging}
              onClick={handleEnforceRetention}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
            >
              <Trash className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{purging ? 'Running Sweep...' : 'Enforce Retention Now'}</span>
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Video Vault Directory
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  required
                  value={storageDir}
                  onChange={(e) => setStorageDir(e.target.value)}
                  className="flex-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 font-mono text-xs text-slate-900 dark:text-slate-100"
                />
                {isTauriDesktop() && (
                  <button
                    type="button"
                    onClick={async () => {
                      const picked = await pickDesktopDirectory('Select Video Vault Directory');
                      if (picked) setStorageDir(picked);
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap"
                  >
                    <FolderOpen className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Browse</span>
                  </button>
                )}
              </div>
            </div>

            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Thumbnail Cache Directory
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  required
                  value={thumbDir}
                  onChange={(e) => setThumbDir(e.target.value)}
                  className="flex-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 font-mono text-xs text-slate-900 dark:text-slate-100"
                />
                {isTauriDesktop() && (
                  <button
                    type="button"
                    onClick={async () => {
                      const picked = await pickDesktopDirectory('Select Thumbnail Cache Directory');
                      if (picked) setThumbDir(picked);
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap"
                  >
                    <FolderOpen className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Browse</span>
                  </button>
                )}
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Storage Soft Quota (GB)
              </label>
              <input
                type="number"
                min={1}
                max={100000}
                value={quotaGb}
                onChange={(e) => setQuotaGb(e.target.value)}
                className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-sm tabular-nums text-slate-900 dark:text-slate-100"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Default Retention Period (Days)
              </label>
              <input
                type="number"
                min={1}
                max={3650}
                value={retentionDays}
                onChange={(e) => setRetentionDays(e.target.value)}
                className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-sm tabular-nums text-slate-900 dark:text-slate-100"
              />
            </div>
          </div>
        </section>

        <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724] p-6 space-y-4">
          <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
            Privacy Masking, AI Thresholds & Consent Governance
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Default Privacy Masking
              </label>
              <select
                value={privacyBlur}
                onChange={(e) => setPrivacyBlur(e.target.value)}
                className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
              >
                <option value="true">Enabled — Mask unconsented subjects by default</option>
                <option value="false">Disabled — Explicit operator review</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Redaction Filter Mode
              </label>
              <select
                value={privacyMaskMode}
                onChange={(e) => setPrivacyMaskMode(e.target.value)}
                className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
              >
                <option value="blur">Gaussian / Box Blur</option>
                <option value="pixelate">Mosaic Pixelation</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Detection Confidence Threshold (0.10 – 0.95)
              </label>
              <input
                type="number"
                step="0.05"
                min={0.1}
                max={0.95}
                value={detThreshold}
                onChange={(e) => setDetThreshold(e.target.value)}
                className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-sm tabular-nums text-slate-900 dark:text-slate-100"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Detection Frame Sample Rate (FPS)
              </label>
              <input
                type="number"
                step="0.5"
                min={0.5}
                max={15}
                value={detSampleFps}
                onChange={(e) => setDetSampleFps(e.target.value)}
                className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-sm tabular-nums text-slate-900 dark:text-slate-100"
              />
            </div>

            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Consent Policy for Authorized Profiles
              </label>
              <select
                value={requireConsent}
                onChange={(e) => setRequireConsent(e.target.value)}
                className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
              >
                <option value="true">Enforced — Block authorized status without granted consent</option>
                <option value="false">Advisory — Allow unverified registration</option>
              </select>
            </div>
          </div>
        </section>

        <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724] p-6 space-y-4">
          <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
            Appearance & System Runtime
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Interface Theme
              </label>
              <select
                value={theme}
                onChange={(e) => onChangeTheme(e.target.value as ThemeMode)}
                className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
              >
                <option value="dark">Dark (Enterprise Default)</option>
                <option value="light">Light</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Backend Log Level
              </label>
              <select
                value={logLevel}
                onChange={(e) => setLogLevel(e.target.value)}
                className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
              >
                <option value="INFO">INFO</option>
                <option value="DEBUG">DEBUG</option>
                <option value="WARNING">WARNING</option>
                <option value="ERROR">ERROR</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Database Engine
              </label>
              <input
                type="text"
                readOnly
                value={settings?.database_engine || 'SQLite 3 (PostgreSQL migration ready)'}
                className="w-full rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0D121D] px-3 py-2 text-xs text-slate-600 dark:text-slate-400"
              />
            </div>
          </div>
        </section>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-md text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{saving ? 'Saving Settings...' : 'Save Configuration'}</span>
          </button>
        </div>
      </form>
    </div>
  );
}
