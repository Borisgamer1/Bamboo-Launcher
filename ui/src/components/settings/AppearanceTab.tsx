import React, { useRef, useState } from 'react'
import { Check, RotateCcw, Search, Trash2, Upload } from 'lucide-react'
import { PRESET_BLUR, PRESET_BRIGHTNESS } from '../../data/themes'
import { prepareInstanceCover } from '../../lib/instanceCovers'
import type { ThemeDefinition } from '../../services/themeService'
import type { LauncherFont } from '../../lib/launcherFont'
import type { ThemeMode } from '../../hooks/useTheme'
import { FontSettingsCard } from './FontSettingsCard'
import {
  Button,
  Segmented,
  SettingsCard,
  SettingsRow,
  Slider,
  TextField,
  Toggle,
  type Lang,
} from './SettingsPrimitives'
import { cx, t } from './settingsUtils'

export interface AppearanceTabProps {
  lang: Lang
  themes: ThemeDefinition[]
  themeId: string
  setThemeId: (themeId: string) => void
  mode: ThemeMode
  setMode: (mode: ThemeMode) => void
  themeQuery: string
  setThemeQuery: (query: string) => void
  customAccent: string
  setCustomAccent: (accent: string) => void
  accentDraft: string
  setAccentDraft: (value: string) => void
  customBg: string
  setCustomBg: (bg: string) => void
  showBgImage: boolean
  setShowBgImage: (value: boolean) => void
  bgBrightness: number
  setBgBrightness: (value: number) => void
  bgBlur: number
  setBgBlur: (value: number) => void
  showParticles: boolean
  setShowParticles: (value: boolean) => void
  showGlow: boolean
  setShowGlow: (value: boolean) => void
  launcherFont: LauncherFont
  setLauncherFont: (font: LauncherFont) => void
  addToast: (toast: { type: 'success' | 'error'; message: string }) => void
}

function themeBackground(theme: ThemeDefinition): string | undefined {
  return theme.bgImage
}

/** Appearance tab: theme picker plus the custom colours, background and effects. */
export function AppearanceTab({
  lang,
  themes,
  themeId,
  setThemeId,
  mode,
  setMode,
  themeQuery,
  setThemeQuery,
  customAccent,
  setCustomAccent,
  accentDraft,
  setAccentDraft,
  customBg,
  setCustomBg,
  showBgImage,
  setShowBgImage,
  bgBrightness,
  setBgBrightness,
  bgBlur,
  setBgBlur,
  showParticles,
  setShowParticles,
  showGlow,
  setShowGlow,
  launcherFont,
  setLauncherFont,
  addToast,
}: AppearanceTabProps) {
  const L = lang
  const [uploadingBackground, setUploadingBackground] = useState(false)
  const backgroundInputRef = useRef<HTMLInputElement>(null)

  const updateCustomAccent = (value: string) => {
    const next = value.startsWith('#') ? value : `#${value}`
    setAccentDraft(next)
    if (/^#[0-9a-f]{6}$/i.test(next)) setCustomAccent(next.toLowerCase())
  }

  const handleBackgroundFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file || !file.type.startsWith('image/')) return

    setUploadingBackground(true)
    try {
      const dataUrl = await new Promise<string | null>((resolve) => {
        const reader = new FileReader()
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
        reader.onerror = () => resolve(null)
        reader.readAsDataURL(file)
      })
      if (!dataUrl) {
        addToast({ type: 'error', message: t(L, 'Bild konnte nicht geladen werden.', 'Could not load the image.') })
        return
      }
      setCustomBg(await prepareInstanceCover(dataUrl))
      setShowBgImage(true)
    } finally {
      setUploadingBackground(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <FontSettingsCard lang={lang} value={launcherFont} onChange={setLauncherFont} />

      <section>
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 className="m-0 text-small font-medium text-ink">{t(L, 'Themes', 'Themes')}</h3>
            <p className="m-0 mt-0.5 max-w-[62ch] text-mini leading-5 text-ink-secondary">
              {t(
                L,
                'Jedes Theme bringt eine eigene Akzentfarbe, einen Hintergrund und Partikel mit.',
                'Every theme ships its own accent color, background and particles.',
              )}
            </p>
          </div>
          <Segmented<ThemeMode>
            value={mode}
            onChange={setMode}
            className="self-start"
            options={[
              { value: 'preset', label: t(L, 'Presets', 'Presets') },
              { value: 'custom', label: t(L, 'Eigene Farben', 'Custom') },
            ]}
          />
        </div>

        {mode === 'preset' ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-micro text-ink-tertiary">
                {themes.length} Themes · {t(L, 'lokal mit dem Launcher ausgeliefert', 'shipped locally with the launcher')}
              </span>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-quaternary" />
                <input
                  type="search"
                  value={themeQuery}
                  onChange={(event) => setThemeQuery(event.target.value)}
                  placeholder={t(L, 'Themes suchen …', 'Search themes …')}
                  className="h-8 w-52 rounded-md border border-hairline bg-canvas pl-8 pr-2 text-mini text-ink outline-none placeholder:text-ink-quaternary transition-colors hover:border-rim focus:border-accent/50"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {themes
                .filter((theme) =>
                  `${theme.name} ${theme.desc} ${theme.accentLabel}`
                    .toLocaleLowerCase()
                    .includes(themeQuery.trim().toLocaleLowerCase()),
                )
                .map((theme) => {
                  const active = theme.id === themeId
                  const bg = themeBackground(theme)
                  return (
                    <button
                      key={theme.id}
                      type="button"
                      onClick={() => setThemeId(theme.id)}
                      className={cx(
                        'group overflow-hidden rounded-[10px] border bg-canvas text-left transition-colors duration-[var(--t-quick)] ease-[var(--ease-out)] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                        active ? 'border-accent/50' : 'border-hairline hover:border-rim',
                      )}
                    >
                      <div className="relative h-[124px] overflow-hidden bg-root">
                        {bg ? (
                          <img
                            src={bg}
                            alt=""
                            loading="lazy"
                            className="h-full w-full object-cover"
                            onError={(event) => {
                              (event.target as HTMLImageElement).style.display = 'none'
                            }}
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center">
                            <span
                              className="h-8 w-8 rounded-full"
                              style={{ backgroundColor: theme.accent }}
                            />
                          </div>
                        )}
                        <span
                          className="absolute inset-x-0 top-0 h-[3px]"
                          style={{ backgroundColor: theme.accent }}
                        />
                        {active && (
                          <span className="absolute right-2.5 top-2.5 flex h-6 w-6 items-center justify-center rounded-full bg-root/85 ring-1 ring-white/15">
                            <Check className="h-3.5 w-3.5 text-accent" />
                          </span>
                        )}
                      </div>
                      <div className="px-3.5 py-2.5">
                        <div className="flex items-baseline justify-between gap-2">
                          <h3 className="m-0 truncate text-small font-medium text-ink">{theme.name}</h3>
                          <span className="shrink-0 font-mono text-micro text-ink-quaternary">{theme.accent}</span>
                        </div>
                        <p className="m-0 mt-0.5 line-clamp-2 min-h-8 text-micro leading-4 text-ink-secondary">
                          {theme.desc?.[L] || t(L, 'Bamboo Theme', 'Bamboo theme')}
                        </p>
                      </div>
                    </button>
                  )
                })}
            </div>

            {themes.length === 0 && (
              <div className="rounded-lg border border-hairline bg-canvas px-5 py-8 text-center">
                <p className="m-0 text-small font-medium text-ink">
                  {t(L, 'Noch keine Themes geladen', 'No themes loaded yet')}
                </p>
                <p className="m-0 mt-1 text-mini text-ink-secondary">
                  {t(L, 'Sobald die Content-Sammlung synchronisiert ist, erscheinen sie hier.', 'They appear here once the content collection has synced.')}
                </p>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <SettingsCard
              title={t(L, 'Eigenes Farbschema', 'Custom scheme')}
              description={t(L, 'Eigene Akzentfarbe für die gesamte Oberfläche.', 'Your own accent color for the whole interface.')}
            >
              <SettingsRow
                title={t(L, 'Akzentfarbe', 'Accent color')}
                description={t(L, 'Wird sofort übernommen und gespeichert.', 'Applied and saved immediately.')}
                control={
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={customAccent}
                      onChange={(event) => {
                        setCustomAccent(event.target.value)
                        updateCustomAccent(event.target.value)
                      }}
                      aria-label={t(L, 'Akzentfarbe wählen', 'Choose accent color')}
                      className="h-9 w-10 cursor-pointer rounded-md border border-hairline bg-root p-0.5"
                    />
                    <TextField
                      value={accentDraft}
                      onChange={updateCustomAccent}
                      mono
                      className="w-28"
                      ariaLabel={t(L, 'Akzentfarbe als Hex-Wert', 'Accent color as hex value')}
                    />
                  </div>
                }
              />
              <SettingsRow
                title={t(L, 'Hintergrundbild', 'Background image')}
                description={
                  customBg
                    ? t(L, 'Eigenes Bild ist aktiv.', 'Your own image is active.')
                    : t(L, 'PNG, JPG oder WebP.', 'PNG, JPG or WebP.')
                }
                control={
                  <div className="flex items-center gap-2">
                    {customBg && (
                      <img
                        src={customBg}
                        alt=""
                        className="h-9 w-16 rounded-md border border-hairline object-cover"
                      />
                    )}
                    <input
                      ref={backgroundInputRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={handleBackgroundFile}
                      aria-label={t(L, 'Hintergrundbild auswählen', 'Choose background image')}
                    />
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<Upload className="h-3 w-3" />}
                      onClick={() => backgroundInputRef.current?.click()}
                      disabled={uploadingBackground}
                    >
                      {uploadingBackground
                        ? t(L, 'Lädt …', 'Loading …')
                        : customBg
                          ? t(L, 'Ändern', 'Change')
                          : t(L, 'Bild wählen', 'Choose image')}
                    </Button>
                    {customBg && (
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<Trash2 className="h-3 w-3" />}
                        onClick={() => setCustomBg('')}
                      >
                        {t(L, 'Entfernen', 'Remove')}
                      </Button>
                    )}
                  </div>
                }
              />
            </SettingsCard>
          </div>
        )}

        <div className="mt-4 flex flex-col gap-4">
          <SettingsCard
              title={t(L, 'Hintergrund', 'Background')}
              description={t(
                L,
                'Das Hintergrundbild liegt hinter allen Ansichten.',
                'The background image sits behind every view.',
              )}
            >
              <SettingsRow
                title={t(L, 'Hintergrundbild anzeigen', 'Show background image')}
                description={t(L, 'Blendet das Hintergrundbild hinter dem Launcher ein.', 'Shows the background image behind the launcher.')}
                control={<Toggle checked={showBgImage} onChange={setShowBgImage} label={t(L, 'Hintergrund', 'Background')} />}
              />
              <SettingsRow
                title={t(L, 'Helligkeit', 'Brightness')}
                description={t(L, 'Wie stark das Hintergrundbild durchscheint.', 'How strongly the background shows through.')}
                control={
                  <div className="w-[240px] max-w-[42vw]">
                    <Slider
                      min={0}
                      max={100}
                      value={bgBrightness}
                      disabled={!showBgImage}
                      onChange={setBgBrightness}
                      formatValue={(value) => `${value} %`}
                    />
                  </div>
                }
              />
              <SettingsRow
                title={t(L, 'Unschärfe', 'Blur')}
                description={t(L, 'Weichzeichnet das Hintergrundbild für mehr Lesbarkeit.', 'Softens the artwork for better readability.')}
                control={
                  <div className="w-[240px] max-w-[42vw]">
                    <Slider
                      min={0}
                      max={20}
                      value={bgBlur}
                      disabled={!showBgImage}
                      onChange={setBgBlur}
                      formatValue={(value) => `${value} px`}
                    />
                  </div>
                }
              />
            </SettingsCard>

            <SettingsCard
              title={t(L, 'Effekte', 'Effects')}
              description={t(L, 'Kleine Details, die den Launcher lebendig machen.', 'Small details that bring the launcher to life.')}
            >
              <SettingsRow
                title={t(L, 'Partikel', 'Particles')}
                description={t(L, 'Schwebende Partikel in der Akzentfarbe des Themes.', 'Floating particles in the theme accent color.')}
                control={<Toggle checked={showParticles} onChange={setShowParticles} label={t(L, 'Partikel', 'Particles')} />}
              />
              <SettingsRow
                title={t(L, 'Atmosphärischer Glow', 'Atmospheric glow')}
                description={t(L, 'Farbige Lichtstimmung über dem Hintergrund.', 'Colored light wash on top of the background.')}
                control={<Toggle checked={showGlow} onChange={setShowGlow} label={t(L, 'Glow', 'Glow')} />}
              />
            </SettingsCard>

            <div className="flex justify-end">
              <Button
                variant="ghost"
                icon={<RotateCcw className="h-3.5 w-3.5" />}
                onClick={() => {
                  setShowBgImage(true)
                  setShowParticles(true)
                  setShowGlow(true)
                  setBgBrightness(PRESET_BRIGHTNESS)
                  setBgBlur(PRESET_BLUR)
                  addToast({ type: 'success', message: t(L, 'Darstellung zurückgesetzt.', 'Appearance reset.') })
                }}
              >
                {t(L, 'Darstellung zurücksetzen', 'Reset appearance')}
              </Button>
            </div>
        </div>
      </section>
    </div>
  )
}
