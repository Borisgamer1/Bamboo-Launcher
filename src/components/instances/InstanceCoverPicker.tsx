import React, { useState } from "react";
import { Check, ImageOff, Images, RefreshCw, Upload } from "lucide-react";
import { translations, type LanguageType } from "../../lib/translations";
import {
  INSTANCE_COVER_IDS,
  instanceCoverLabel,
  instanceCoverSrc,
  prepareInstanceCover,
  readUploadedInstanceCovers,
  saveUploadedInstanceCover,
  type UploadedInstanceCover,
} from "../../lib/instanceCovers";

interface InstanceCoverPickerProps {
  value: string;
  onChange: (value: string) => void;
  lang: LanguageType;
}

type CoverTab = "templates" | "uploaded";

const tileBase =
  "group relative aspect-video overflow-hidden rounded-lg border bg-root/40 transition-[border-color,box-shadow,transform] duration-[var(--t-quick)] ease-[var(--ease-out)] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50";

/**
 * Cover selection used by instance creation: a labeled grid of bundled
 * wallpapers and a second tab with images uploaded once for reuse.
 */
export const InstanceCoverPicker: React.FC<InstanceCoverPickerProps> = ({ value, onChange, lang }) => {
  const t = translations[lang];
  const [tab, setTab] = useState<CoverTab>("templates");
  const [uploaded, setUploaded] = useState<UploadedInstanceCover[]>(readUploadedInstanceCovers);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");

  const handleUpload = async () => {
    setUploadError("");
    const result = await window.electronAPI?.dialogs.open?.({
      properties: ["openFile"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
    });
    if (!result || result.canceled || result.filePaths.length === 0) return;

    setUploading(true);
    try {
      const dataUrl = await window.electronAPI?.dialogs.readImage?.(result.filePaths[0]);
      if (!dataUrl) return;
      const prepared = await prepareInstanceCover(dataUrl);
      const saved = saveUploadedInstanceCover(prepared);
      onChange(saved?.dataUrl ?? prepared);
      if (saved) {
        setUploaded(readUploadedInstanceCovers());
        setTab("uploaded");
      } else {
        setUploadError(t.instanceCoverUploadFailed);
      }
    } finally {
      setUploading(false);
    }
  };

  const selectedId = (() => {
    const match = /instance-covers\/([^/]+)\.jpg$/.exec(value);
    return match?.[1] ?? null;
  })();

  const tileClass = (selected: boolean) =>
    `${tileBase} ${
      selected
        ? "border-accent ring-2 ring-accent/35"
        : "border-stroke hover:border-rim hover:-translate-y-px"
    }`;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <label className="text-micro font-medium text-ink-secondary uppercase tracking-label">
          {t.instanceImage}
        </label>
        <div className="flex bg-surface/40 border border-stroke p-0.5 rounded-lg">
          {([
            { id: "templates" as const, label: t.instanceCoverTemplates, icon: Images },
            { id: "uploaded" as const, label: t.instanceCoverUploaded, icon: Upload },
          ]).map((entry) => {
            const Icon = entry.icon;
            return (
              <button
                key={entry.id}
                type="button"
                onClick={() => setTab(entry.id)}
                className={`px-2.5 py-1 rounded-md text-micro font-medium flex items-center gap-1.5 transition-[color,background-color,border-color] cursor-pointer ${
                  tab === entry.id
                    ? "bg-accent/12 text-accent"
                    : "text-ink-secondary hover:text-ink"
                }`}
              >
                <Icon className="w-3 h-3" />
                {entry.label}
              </button>
            );
          })}
        </div>
      </div>

      {tab === "templates" ? (
        <div className="grid grid-cols-3 gap-2 max-h-56 overflow-y-auto custom-scrollbar pr-1">
          <button
            type="button"
            onClick={() => onChange("")}
            title={t.instanceCoverNone}
            aria-label={t.instanceCoverNone}
            className={`${tileClass(value === "")} flex flex-col items-center justify-center gap-1 text-ink-tertiary hover:text-ink-secondary`}
          >
            <ImageOff className="w-4 h-4" />
            <span className="text-micro font-medium">{t.instanceCoverNone}</span>
            {value === "" && <Check className="absolute right-1.5 top-1.5 w-3.5 h-3.5 text-accent" />}
          </button>
          {INSTANCE_COVER_IDS.map((id) => {
            const selected = selectedId === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => onChange(instanceCoverSrc(id))}
                title={instanceCoverLabel(id)}
                aria-label={instanceCoverLabel(id)}
                aria-pressed={selected}
                className={tileClass(selected)}
              >
                <img
                  src={instanceCoverSrc(id)}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className={`h-full w-full object-cover transition-transform duration-[var(--t-out)] ease-[var(--ease-out)] ${
                    selected ? "" : "group-hover:scale-[1.04]"
                  }`}
                />
                {selected && (
                  <span className="absolute inset-0 bg-accent/15 flex items-center justify-center">
                    <span className="w-5 h-5 rounded-full bg-accent text-accent-contrast flex items-center justify-center shadow-lg">
                      <Check className="w-3 h-3 stroke-[3]" />
                    </span>
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {uploaded.length > 0 && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleUpload}
                disabled={uploading}
                className="shrink-0 h-7 px-2.5 rounded-lg border border-stroke bg-surface/40 hover:bg-selected text-micro font-medium text-ink flex items-center gap-1.5 transition-[color,background-color,border-color] cursor-pointer disabled:opacity-60"
              >
                {uploading ? (
                  <RefreshCw className="w-3 h-3 animate-spin" />
                ) : (
                  <Upload className="w-3 h-3" />
                )}
                {t.instanceCoverUpload}
              </button>
            </div>
          )}
          {uploadError && <p className="text-micro text-warning">{uploadError}</p>}
          {uploaded.length > 0 ? (
            <div className="grid grid-cols-3 gap-2 max-h-56 overflow-y-auto custom-scrollbar pr-1">
              {uploaded.map((cover) => {
                const selected = value === cover.dataUrl;
                return (
                  <button
                    key={cover.id}
                    type="button"
                    onClick={() => onChange(cover.dataUrl)}
                    aria-pressed={selected}
                    className={tileClass(selected)}
                  >
                    <img
                      src={cover.dataUrl}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      className={`h-full w-full object-cover transition-transform duration-[var(--t-out)] ease-[var(--ease-out)] ${
                        selected ? "" : "group-hover:scale-[1.04]"
                      }`}
                    />
                    {selected && (
                      <span className="absolute inset-0 bg-accent/15 flex items-center justify-center">
                        <span className="w-5 h-5 rounded-full bg-accent text-accent-contrast flex items-center justify-center shadow-lg">
                          <Check className="w-3 h-3 stroke-[3]" />
                        </span>
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ) : (
            <button
              type="button"
              onClick={handleUpload}
              disabled={uploading}
              className="min-h-24 rounded-xl border-2 border-dashed border-stroke bg-surface/20 hover:border-accent/40 hover:bg-accent/5 flex flex-col items-center justify-center gap-1.5 text-ink-secondary hover:text-ink transition-[color,background-color,border-color] cursor-pointer"
            >
              <Upload className="w-4 h-4" />
              <span className="text-small font-medium">{t.instanceCoverUpload}</span>
              <span className="text-micro text-ink-tertiary max-w-[240px] text-center">
                {t.instanceCoverEmptyUploads}
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  );
};
