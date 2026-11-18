import { useState, type FormEvent } from 'react';
import { Film, Upload, X } from 'lucide-react';
import { api, formatBytes } from '../api/client.ts';
import type { CameraRecord, VideoFileRecord } from '../../shared/types.ts';

interface VideoImportModalProps {
  open: boolean;
  cameras: CameraRecord[];
  onClose: () => void;
  onImported: (video: VideoFileRecord) => void;
}

export function VideoImportModal({
  open,
  cameras,
  onClose,
  onImported,
}: VideoImportModalProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [cameraId, setCameraId] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedFile) {
      setError('Select a local video file to import.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const record = await api.importVideo(selectedFile, cameraId || null);
      setSelectedFile(null);
      setCameraId('');
      onImported(record);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to import video file.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/65 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-modal-title"
        className="w-full max-w-lg rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724] shadow-xl"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-800">
          <div className="flex items-center gap-2.5">
            <Film className="h-4 w-4 text-blue-600 dark:text-blue-400" aria-hidden="true" />
            <h2
              id="import-modal-title"
              className="font-display text-base font-semibold text-slate-900 dark:text-slate-100"
            >
              Import CCTV Video Asset
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
            aria-label="Close import dialog"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-2">
              Video File (MP4, MKV, MOV, AVI, WebM)
            </label>
            <label className="flex flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-[#0D121D] px-4 py-8 cursor-pointer hover:border-blue-500 transition-colors">
              <Upload className="h-6 w-6 text-slate-400 mb-2" aria-hidden="true" />
              <span className="text-sm font-medium text-slate-800 dark:text-slate-200">
                {selectedFile ? selectedFile.name : 'Choose a local video file'}
              </span>
              <span className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {selectedFile
                  ? `${formatBytes(selectedFile.size)} · SHA-256 checksum & FFmpeg inspection run automatically`
                  : 'Stored in your configured local storage vault'}
              </span>
              <input
                type="file"
                accept="video/*,.mp4,.mkv,.mov,.avi,.webm"
                className="sr-only"
                onChange={(e) => {
                  setSelectedFile(e.target.files?.[0] ?? null);
                  setError(null);
                }}
              />
            </label>
          </div>

          <div>
            <label
              htmlFor="import-camera-select"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
            >
              Source Camera (Optional)
            </label>
            <select
              id="import-camera-select"
              value={cameraId}
              onChange={(e) => setCameraId(e.target.value)}
              className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
            >
              <option value="">Unassigned local archive file</option>
              {cameras.map((cam) => (
                <option key={cam.id} value={cam.id}>
                  {cam.name} ({cam.location_zone})
                </option>
              ))}
            </select>
          </div>

          {error && (
            <div className="rounded-md border border-red-300 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 px-3 py-2 text-xs text-red-700 dark:text-red-300">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-4 py-2 rounded-md text-xs font-medium border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !selectedFile}
              className="px-4 py-2 rounded-md text-xs font-semibold bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white transition-colors"
            >
              {submitting ? 'Importing & Inspecting...' : 'Import to Local Vault'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
