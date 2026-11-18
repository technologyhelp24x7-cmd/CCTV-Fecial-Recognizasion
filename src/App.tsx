import { useCallback, useEffect, useState } from 'react';
import { api, waitForDesktopBackend } from './api/client.ts';
import { Sidebar } from './components/Sidebar.tsx';
import { TopBar } from './components/TopBar.tsx';
import { VideoImportModal } from './components/VideoImportModal.tsx';
import { AiDetectionView } from './views/AiDetectionView.tsx';
import { AuditLogsView } from './views/AuditLogsView.tsx';
import { CameraManagementView } from './views/CameraManagementView.tsx';
import { DashboardView } from './views/DashboardView.tsx';
import { PersonGalleryView } from './views/PersonGalleryView.tsx';
import { PersonProfilesView } from './views/PersonProfilesView.tsx';
import { ReportsView } from './views/ReportsView.tsx';
import { SettingsView } from './views/SettingsView.tsx';
import { VideoLibraryView } from './views/VideoLibraryView.tsx';
import { VideoTimelineView } from './views/VideoTimelineView.tsx';
import { WatchlistReviewView } from './views/WatchlistReviewView.tsx';
import type {
  AiEngineDescriptor,
  AnonymousTrackRecord,
  AppSettingsMap,
  AuditLogRecord,
  CameraRecord,
  DashboardSummary,
  NavModuleId,
  PersonEventRecord,
  PersonProfileRecord,
  ProcessingJobRecord,
  ThemeMode,
  VideoFileRecord,
  WatchlistReviewRecord,
} from '../shared/types.ts';

export default function App() {
  const [activeModule, setActiveModule] = useState<NavModuleId>('dashboard');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [timelineVideoId, setTimelineVideoId] = useState<string | null>(null);
  const [timelineSeekSec, setTimelineSeekSec] = useState<number | null>(null);

  const [theme, setTheme] = useState<ThemeMode>(() => {
    const saved = window.localStorage.getItem('lumaflux_theme');
    return saved === 'light' ? 'light' : 'dark';
  });

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [videos, setVideos] = useState<VideoFileRecord[]>([]);
  const [cameras, setCameras] = useState<CameraRecord[]>([]);
  const [personEvents, setPersonEvents] = useState<PersonEventRecord[]>([]);
  const [anonymousTracks, setAnonymousTracks] = useState<AnonymousTrackRecord[]>([]);
  const [profiles, setProfiles] = useState<PersonProfileRecord[]>([]);
  const [aiEngines, setAiEngines] = useState<AiEngineDescriptor[]>([]);
  const [aiJobs, setAiJobs] = useState<ProcessingJobRecord[]>([]);
  const [reviews, setReviews] = useState<WatchlistReviewRecord[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogRecord[]>([]);
  const [settings, setSettings] = useState<AppSettingsMap | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    window.localStorage.setItem('lumaflux_theme', theme);
  }, [theme]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await waitForDesktopBackend();
      const [
        summaryRes,
        videosRes,
        camerasRes,
        eventsRes,
        tracksRes,
        profilesRes,
        enginesRes,
        jobsRes,
        reviewsRes,
        auditRes,
        settingsRes,
      ] = await Promise.all([
        api.getDashboardSummary(),
        api.listVideos(),
        api.listCameras(),
        api.listPersonEvents(),
        api.listAnonymousTracks(),
        api.listProfiles(),
        api.listAiEngines(),
        api.listAiJobs(),
        api.listWatchlistReviews(),
        api.listAuditLogs(150),
        api.getSettings(),
      ]);

      setSummary(summaryRes);
      setVideos(videosRes);
      setCameras(camerasRes);
      setPersonEvents(eventsRes);
      setAnonymousTracks(tracksRes);
      setProfiles(profilesRes);
      setAiEngines(enginesRes);
      setAiJobs(jobsRes);
      setReviews(reviewsRes);
      setAuditLogs(auditRes);
      setSettings(settingsRes);

      if (settingsRes.theme === 'light' || settingsRes.theme === 'dark') {
        const localSaved = window.localStorage.getItem('lumaflux_theme');
        if (!localSaved) {
          setTheme(settingsRes.theme);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to connect to LumaFlux backend API.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const handleToggleTheme = async () => {
    const next: ThemeMode = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    try {
      await api.updateSettings({ theme: next });
    } catch {
      // Theme still applies locally even if backend sync fails momentarily
    }
  };

  const handleChangeTheme = async (next: ThemeMode) => {
    setTheme(next);
    try {
      await api.updateSettings({ theme: next });
    } catch {
      // Non-blocking UI theme update
    }
  };

  const handleOpenTimelineForVideo = (videoId: string, seekSec: number | null = null) => {
    setTimelineVideoId(videoId);
    setTimelineSeekSec(seekSec);
    setActiveModule('video-timeline');
  };

  const privacyMaskMode: 'blur' | 'pixelate' =
    settings?.privacy_mask_mode === 'pixelate' ? 'pixelate' : 'blur';

  return (
    <div className="min-h-screen flex bg-slate-50 text-slate-900 dark:bg-[#0B0F17] dark:text-slate-100">
      <Sidebar
        activeModule={activeModule}
        onSelectModule={setActiveModule}
        mobileOpen={mobileMenuOpen}
        onCloseMobile={() => setMobileMenuOpen(false)}
        pendingReviewsCount={summary?.pending_security_reviews ?? 0}
      />

      <div className="flex-1 min-w-0 flex flex-col">
        <TopBar
          activeModule={activeModule}
          theme={theme}
          onToggleTheme={handleToggleTheme}
          onOpenMobileMenu={() => setMobileMenuOpen(true)}
          onOpenImportModal={() => setImportModalOpen(true)}
        />

        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-[1440px] w-full mx-auto">
          {activeModule === 'dashboard' && (
            <DashboardView
              summary={summary}
              loading={loading}
              error={error}
              onRetry={loadAll}
              onNavigate={setActiveModule}
              onOpenImportModal={() => setImportModalOpen(true)}
            />
          )}

          {activeModule === 'video-library' && (
            <VideoLibraryView
              videos={videos}
              loading={loading}
              error={error}
              privacyMaskMode={privacyMaskMode}
              onRefresh={loadAll}
              onOpenImportModal={() => setImportModalOpen(true)}
              onOpenTimelineForVideo={(id) => handleOpenTimelineForVideo(id, null)}
            />
          )}

          {activeModule === 'person-gallery' && (
            <PersonGalleryView
              events={personEvents}
              tracks={anonymousTracks}
              cameras={cameras}
              profiles={profiles}
              loading={loading}
              error={error}
              onRefresh={loadAll}
              onNavigate={setActiveModule}
              onJumpToTimeline={(videoId, ts) => handleOpenTimelineForVideo(videoId, ts)}
            />
          )}

          {activeModule === 'person-profiles' && (
            <PersonProfilesView
              profiles={profiles}
              loading={loading}
              error={error}
              onRefresh={loadAll}
            />
          )}

          {activeModule === 'camera-management' && (
            <CameraManagementView
              cameras={cameras}
              loading={loading}
              error={error}
              onRefresh={loadAll}
            />
          )}

          {activeModule === 'video-timeline' && (
            <VideoTimelineView
              videos={videos}
              events={personEvents}
              selectedVideoId={timelineVideoId}
              seekTimeSec={timelineSeekSec}
              privacyMaskMode={privacyMaskMode}
              onSelectVideo={(id) => {
                setTimelineVideoId(id);
                setTimelineSeekSec(null);
              }}
              onOpenImportModal={() => setImportModalOpen(true)}
              onRefresh={loadAll}
            />
          )}

          {activeModule === 'ai-detection' && (
            <AiDetectionView
              engines={aiEngines}
              jobs={aiJobs}
              videos={videos}
              settings={settings}
              loading={loading}
              error={error}
              onRefresh={loadAll}
            />
          )}

          {activeModule === 'watchlist-review' && (
            <WatchlistReviewView
              reviews={reviews}
              profiles={profiles}
              videos={videos}
              loading={loading}
              error={error}
              onRefresh={loadAll}
            />
          )}

          {activeModule === 'reports' && <ReportsView summary={summary} />}

          {activeModule === 'audit-logs' && (
            <AuditLogsView
              logs={auditLogs}
              loading={loading}
              error={error}
              onRefresh={loadAll}
            />
          )}

          {activeModule === 'settings' && (
            <SettingsView
              settings={settings}
              loading={loading}
              error={error}
              theme={theme}
              onChangeTheme={handleChangeTheme}
              onRefresh={loadAll}
            />
          )}
        </main>
      </div>

      <VideoImportModal
        open={importModalOpen}
        cameras={cameras}
        onClose={() => setImportModalOpen(false)}
        onImported={(video) => {
          setTimelineVideoId(video.id);
          setTimelineSeekSec(null);
          void loadAll();
        }}
      />
    </div>
  );
}
