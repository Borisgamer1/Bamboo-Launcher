import { join } from 'node:path'
import type { AnalysisContext, CrashRule, FixAction, ReasonCode } from './types'

const GRAPHICS_HELP_URLS = {
  nvidia: 'https://www.nvidia.com/en-us/drivers/',
  amd: 'https://www.amd.com/en/support/download/drivers.html',
  intel: 'https://www.intel.com/content/www/us/en/download-center/home.html',
  fallback: 'https://www.microsoft.com/en-us/windows/learning-center/how-to-update-drivers',
} as const

function graphicsHelpUrl(vendor: AnalysisContext['graphicsVendor']): string {
  return vendor ? GRAPHICS_HELP_URLS[vendor] : GRAPHICS_HELP_URLS.fallback
}

function switchJava(major: number, reason: ReasonCode): FixAction {
  return { id: '', kind: 'switch-java', major, reason }
}

function disableMod(jar: string, context: AnalysisContext): FixAction {
  return {
    id: '',
    kind: 'disable-mod',
    jar,
    targetDir: join(context.instanceDir, 'mods-disabled'),
  }
}

export const RULES: readonly CrashRule[] = [
  {
    id: 'java-too-old',
    category: 'java',
    pattern: /UnsupportedClassVersionError: .* \(class file version (\d+)\.(\d+)\)/,
    confidence: 'certain',
    title: { de: 'Java zu alt', en: 'Java too old' },
    detail: (match) => {
      const major = Number(match[1]) - 44
      return `Die Mods wurden für Java ${major} kompiliert; die gestartete JVM ist älter.`
    },
    fix: (match) => switchJava(Number(match[1]) - 44, 'crash.rule-java-too-old'),
  },
  {
    id: 'legacy-on-modern-jvm',
    category: 'java',
    pattern:
      /(?:Exception in thread .*|Caused by:\s*).*(?:java\.lang\.reflect\.InaccessibleObjectException|module java\.base does not "opens)|Unrecognized VM option/,
    confidence: 'certain',
    title: { de: 'Alte Mods auf neuer JVM', en: 'Legacy mods on a modern JVM' },
    detail: () => 'Legacy-Mods (z. B. Forge 1.12.2) benötigen Java 8, nicht eine moderne JVM.',
    fix: () => switchJava(8, 'crash.rule-legacy-on-modern-jvm'),
  },
  {
    id: 'missing-dependency-forge',
    category: 'dependency',
    pattern: /Mod ID: '([^']+)', Requested by: '([^']+)', Expected range: '([^']+)'/,
    confidence: 'certain',
    title: { de: 'Mod-Abhängigkeit fehlt', en: 'Missing mod dependency' },
    detail: (match) => `Mod ${match[1]} fehlt (benötigt von ${match[2]}, Bereich ${match[3]}).`,
    fix: (match) => ({
      id: '',
      kind: 'install-dependency',
      modId: match[1],
      versionRange: match[3],
      projectHint: match[1],
    }),
  },
  {
    id: 'missing-dependency-fabric',
    category: 'dependency',
    pattern:
      /[Mm]od '([^']+)' \([^)]+\) \S+ requires (?:any version of|version [^ ]+ or later of) '?([A-Za-z0-9_-]+)'?, which is missing!/,
    confidence: 'likely',
    title: { de: 'Fabric-Abhängigkeit fehlt', en: 'Missing Fabric dependency' },
    detail: (match) => `Mod ${match[2]} fehlt (benötigt von ${match[1]}).`,
    fix: (match) => ({
      id: '',
      kind: 'install-dependency',
      modId: match[2],
      projectHint: match[2],
    }),
  },
  {
    id: 'duplicate-mod',
    category: 'conflict',
    pattern: /Duplicate mods? found|duplicate modid|Found a duplicate mod/,
    confidence: 'certain',
    title: { de: 'Doppelte Mod', en: 'Duplicate mod' },
    detail: () => 'Zwei Versionen derselben Mod liegen in mods/; eine muss deaktiviert werden.',
  },
  {
    id: 'mod-resolution-failed',
    category: 'conflict',
    pattern: /Mod resolution failed|Incompatible mod set/,
    confidence: 'likely',
    title: { de: 'Mod-Konflikt', en: 'Mod resolution failed' },
    detail: () => 'Die Mods bilden keinen auflösbaren Satz; mods/ und die genannten Mods prüfen.',
    fix: (_match, context) => ({
      id: '',
      kind: 'open-path',
      path: join(context.instanceDir, 'mods'),
    }),
  },
  {
    id: 'mixin-apply-failed',
    category: 'conflict',
    pattern: /Mixin apply for mod (\S+) failed|MixinTransformerError/,
    confidence: 'likely',
    title: { de: 'Mixin konnte nicht angewendet werden', en: 'Mixin apply failed' },
    detail: (match) =>
      match[1] ? `Mixin von ${match[1]} konnte nicht angewendet werden.` : 'Ein Mixin konnte nicht angewendet werden.',
    fix: (match, context) =>
      match[1] ? disableMod(`${match[1]}.jar`, context) : undefined,
  },
  {
    id: 'out-of-memory',
    category: 'memory',
    pattern: /java\.lang\.OutOfMemoryError|Java heap space|GC overhead limit exceeded/,
    confidence: 'certain',
    title: { de: 'Zu wenig Arbeitsspeicher', en: 'Out of memory' },
    detail: (_match, context) =>
      `Der Heap ist erschöpft (bisher ${context.maxMemoryMb} MB); 2048 MB mehr werden vorgeschlagen.`,
    fix: (_match, context) => ({
      id: '',
      kind: 'raise-heap',
      toMb: context.maxMemoryMb + 2048,
    }),
  },
  {
    id: 'graphics-driver',
    category: 'graphics',
    pattern: /GLFW error|Failed to create window|Pixel format not accelerated|EXCEPTION_ACCESS_VIOLATION/,
    confidence: 'possible',
    title: { de: 'Grafiktreiber-Problem', en: 'Graphics driver problem' },
    detail: () => 'Die Fenster-/OpenGL-Initialisierung ist fehlgeschlagen; Grafiktreiber prüfen.',
    fix: (_match, context) => ({
      id: '',
      kind: 'open-url',
      url: graphicsHelpUrl(context.graphicsVendor),
    }),
  },
  {
    id: 'corrupt-jar',
    category: 'integrity',
    pattern: /zip END header not found|Invalid or corrupt jarfile|java\.util\.zip\.ZipException/,
    confidence: 'certain',
    title: { de: 'Beschädigte JAR', en: 'Corrupt JAR' },
    detail: () => 'Eine Mod- oder Bibliotheksdatei ist beschädigt; mods/ prüfen und neu installieren.',
    fix: (_match, context) => ({
      id: '',
      kind: 'open-path',
      path: join(context.instanceDir, 'mods'),
    }),
  },
  {
    id: 'no-class-def',
    category: 'unknown',
    pattern: /NoClassDefFoundError: ([\w/$]+)/,
    confidence: 'possible',
    title: { de: 'Klasse fehlt', en: 'Missing class' },
    detail: (match) => `Die Klasse ${match[1]} fehlt; die Herkunft wird über die Mod-Attribution gesucht.`,
  },
] as const
