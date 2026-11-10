import type { LanguageType } from '../../lib/translations'

export interface Localized {
  de: string
  en: string
}

export interface TourStation {
  target: string
  /**
   * "click" means the highlighted control is the way forward: there is no
   * Continue button, the user performs the real action. "next" is a station
   * that only explains something already on screen.
   */
  advance: 'click' | 'next'
  title: Localized
  body: Localized
  /** What to click; required for "click" stations. */
  hint?: Localized
}

interface TourOptions {
  hasInstances: boolean
}

/**
 * The tour walks the real launcher. Steps are derived from the current state:
 * a launcher that already has instances is not taught to create its first one.
 */
export function buildTourStations({ hasInstances }: TourOptions): TourStation[] {
  const stations: TourStation[] = [
    {
      target: '[data-tour="sidebar"]',
      advance: 'next',
      title: { de: 'Alles links.', en: 'Everything on the left.' },
      body: {
        de: 'Home, Instanzen, Mods, Mehrspieler, Screenshots — Einstellungen ganz unten. Wir gehen die wichtigsten Punkte jetzt der Reihe nach durch.',
        en: 'Home, instances, mods, multiplayer, screenshots — settings at the bottom. We walk through the important ones in order.',
      },
    },
    {
      target: '[data-tour="account"]',
      advance: 'next',
      title: { de: 'Dein Konto.', en: 'Your account.' },
      body: {
        de: 'Skin, Spielzeit und Online-Status hängen hier dran. Mit Microsoft-Konto spielst du auf Servern.',
        en: 'Skin, playtime and online status live here. A Microsoft account plays on servers.',
      },
    },
    {
      target: '[data-tour="nav-instances"]',
      advance: 'click',
      title: { de: 'Dein Spiel.', en: 'Your game.' },
      body: {
        de: 'Jede Instanz ist ein eigenes Minecraft mit eigener Version, eigenen Mods und eigenen Welten.',
        en: 'Every instance is its own Minecraft with its own version, mods and worlds.',
      },
      hint: { de: 'Klick auf Instanzen.', en: 'Click instances.' },
    },
  ]

  if (!hasInstances) {
    stations.push(
      {
        target: '[data-tour="instance-create"]',
        advance: 'click',
        title: { de: 'Leg die erste an.', en: 'Create the first one.' },
        body: {
          de: 'Das machen wir jetzt zusammen: Name, Version, fertig. Den Rest kannst du später ändern.',
          en: "Let's do it now: name, version, done. Everything else can change later.",
        },
        hint: { de: 'Klick auf Instanz erstellen.', en: 'Click create instance.' },
      },
      {
        target: '[data-tour="instance-create-confirm"]',
        advance: 'click',
        title: { de: 'Name und Erstellen.', en: 'Name it and create.' },
        body: {
          de: 'Ein Name reicht. Version und Mod-Loader stehen schon richtig da — bestätige einfach.',
          en: 'A name is enough. Version and mod loader are already right — just confirm.',
        },
        hint: { de: 'Klick auf Erstellen.', en: 'Click create.' },
      },
    )
  }

  stations.push(
    {
      target: '[data-tour="instance-card"]',
      advance: 'next',
      title: { de: 'Das ist deine Instanz.', en: 'This is your instance.' },
      body: {
        de: 'Klick auf die Karte: Einstellungen, Mods, Welten. Der Play-Knopf sitzt rechts unten auf der Karte.',
        en: 'Click the card: settings, mods, worlds. The play button sits at its bottom right.',
      },
    },
    {
      target: '[data-tour="nav-mods"]',
      advance: 'click',
      title: { de: 'Mods ohne Suchen.', en: 'Mods without the hunt.' },
      body: {
        de: 'Modrinth und CurseForge in einem Fenster. Updates erkennt Bamboo hier, nicht in irgendeinem Ordner.',
        en: 'Modrinth and CurseForge in one window. Updates are detected here, not in some folder.',
      },
      hint: { de: 'Klick auf Mod-Browser.', en: 'Click the mod browser.' },
    },
    {
      target: '[data-tour="mods-search"]',
      advance: 'next',
      title: { de: 'Suchen, installieren, fertig.', en: 'Search, install, done.' },
      body: {
        de: 'Suchfeld, Filter für Version und Loader — und jede installierte Mod zeigt, ob es ein Update gibt.',
        en: 'Search, filters for version and loader — and every installed mod shows whether it has an update.',
      },
    },
    {
      target: '[data-tour="nav-customize"]',
      advance: 'click',
      title: { de: 'Cosmetics.', en: 'Cosmetics.' },
      body: {
        de: 'Capes, Hüte und Rücken-Accessoires für deinen Skin — installiert einmal, sichtbar in jeder Instanz.',
        en: 'Capes, hats and back accessories for your skin — install once, visible in every instance.',
      },
      hint: { de: 'Klick auf Anpassen.', en: 'Click customize.' },
    },
    {
      target: '[data-tour="cosmetics-stage"]',
      advance: 'next',
      title: { de: 'Im Spiel auswählen.', en: 'Pick it in game.' },
      body: {
        de: 'Cosmetics laufen nur mit Minecraft 26.3 (Fabric). Im Spiel öffnest du sie mit Pause → Cosmetics und wählst dort dein Paket.',
        en: 'Cosmetics run on Minecraft 26.3 (Fabric) only. In game, open Pause → Cosmetics and pick your pack there.',
      },
    },
    {
      target: '[data-tour="nav-settings"]',
      advance: 'click',
      title: { de: 'Die Einstellungen.', en: 'The settings.' },
      body: {
        de: 'Einmal einrichten, danach nie wieder anfassen. Wir gehen die Tabs einzeln durch.',
        en: "Set it up once, never touch it again. We walk the tabs one by one.",
      },
      hint: { de: 'Klick auf Einstellungen.', en: 'Click settings.' },
    },
    {
      target: '[data-tour="settings-tab-general"]',
      advance: 'next',
      title: { de: 'Die Standards.', en: 'The defaults.' },
      body: {
        de: 'Arbeitsspeicher und Java gelten für alle neuen Instanzen. Hier steht auch die Launcher-Sprache.',
        en: 'Memory and Java apply to every new instance. The launcher language lives here too.',
      },
    },
    {
      target: '[data-tour="settings-tab-gameOptions"]',
      advance: 'click',
      title: { de: 'Spieloptionen.', en: 'Game options.' },
      body: {
        de: 'Renderdistanz, Mausempfindlichkeit, Vollbild — Bamboo schreibt sie beim Start in die Instanz.',
        en: 'Render distance, mouse sensitivity, fullscreen — Bamboo writes them into the instance on launch.',
      },
      hint: { de: 'Klick auf Spieloptionen.', en: 'Click game options.' },
    },
    {
      target: '[data-tour="settings-tab-keybinds"]',
      advance: 'click',
      title: { de: 'Tastenbelegungen.', en: 'Key-binds.' },
      body: {
        de: 'Die ganze Tastatur zum Anklicken — Konflikte fallen sofort auf.',
        en: 'The whole keyboard, clickable — conflicts are impossible to miss.',
      },
      hint: { de: 'Klick auf Tastenbelegungen.', en: 'Click key-binds.' },
    },
    {
      target: '[data-tour="settings-tab-appearance"]',
      advance: 'click',
      title: { de: 'Darstellung.', en: 'Appearance.' },
      body: {
        de: 'Neun Themes, die Minecraft-Schrift und eigene Hintergründe. Das ist der letzte Halt.',
        en: 'Nine themes, the Minecraft font and your own backgrounds. Last stop.',
      },
      hint: { de: 'Klick auf Darstellung.', en: 'Click appearance.' },
    },
  )

  return stations
}

export const onboardingCopy = {
  de: {
    welcomeTitle: 'Willkommen.',
    welcomeBody: 'Eine kurze Tour durch deinen Launcher — sie zeigt dir alles, was du wirklich brauchst.',
    start: 'Tour starten',
    skip: 'Überspringen',
    duration: 'Dauert etwa zwei Minuten.',
    next: 'Weiter',
    back: 'Zurück',
    quit: 'Tour beenden',
    skipStep: 'Trotzdem weiter',
    step: (index: number, total: number) => `Schritt ${index} von ${total}`,
    javaTitle: 'Java',
    javaScanning: 'Bamboo sucht deine Java-Versionen …',
    javaFound: 'Gefunden',
    javaNone: 'Kein Java gefunden — Bamboo lädt es beim ersten Start nach.',
    javaFailed: 'Java-Suche nicht möglich — Bamboo sucht beim Start erneut.',
    doneTitle: 'Fertig.',
    doneBody: 'Alles Weitere steckt in den Einstellungen. Viel Spaß.',
    doneAction: "Los geht's",
    changelogTitle: (version: string) => `Was ist neu in v${version}`,
    changelogFoot: 'Changelog jederzeit unter Einstellungen → Über',
    close: 'Schließen',
    whatsNew: 'Was ist neu',
    restartTour: 'Tour erneut starten',
    aboutRow: 'Einführung',
  },
  en: {
    welcomeTitle: 'Welcome.',
    welcomeBody: 'A short tour through your launcher — it shows you everything you actually need.',
    start: 'Start the tour',
    skip: 'Skip',
    duration: 'About two minutes.',
    next: 'Next',
    back: 'Back',
    quit: 'End tour',
    skipStep: 'Continue anyway',
    step: (index: number, total: number) => `Step ${index} of ${total}`,
    javaTitle: 'Java',
    javaScanning: 'Bamboo is looking for your Java runtimes …',
    javaFound: 'Found',
    javaNone: 'No Java found — Bamboo downloads it on first launch.',
    javaFailed: 'Java scan unavailable — Bamboo checks again on launch.',
    doneTitle: 'Done.',
    doneBody: 'Everything else lives in settings. Have fun.',
    doneAction: "Let's go",
    changelogTitle: (version: string) => `What's new in v${version}`,
    changelogFoot: 'Changelog any time under Settings → About',
    close: 'Close',
    whatsNew: "What's new",
    restartTour: 'Start the tour again',
    aboutRow: 'Introduction',
  },
} satisfies Record<LanguageType, unknown>

export function copyFor(lang: LanguageType) {
  return onboardingCopy[lang]
}
