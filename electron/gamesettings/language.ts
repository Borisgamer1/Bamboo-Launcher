import { parseMinecraftVersion } from '../java/version'

const DEFAULT_REGIONS: Readonly<Record<string, string>> = {
  af: 'za',
  ar: 'sa',
  bg: 'bg',
  cs: 'cz',
  da: 'dk',
  de: 'de',
  el: 'gr',
  en: 'us',
  es: 'es',
  et: 'ee',
  fi: 'fi',
  fr: 'fr',
  he: 'il',
  hi: 'in',
  hr: 'hr',
  hu: 'hu',
  id: 'id',
  it: 'it',
  ja: 'jp',
  ko: 'kr',
  lt: 'lt',
  lv: 'lv',
  ms: 'my',
  nb: 'no',
  nl: 'nl',
  no: 'no',
  pl: 'pl',
  pt: 'br',
  ro: 'ro',
  ru: 'ru',
  sk: 'sk',
  sl: 'si',
  sr: 'sp',
  sv: 'se',
  th: 'th',
  tl: 'ph',
  tr: 'tr',
  uk: 'ua',
  vi: 'vn',
  zh: 'cn',
}

const SPECIAL_LOCALES: Readonly<Record<string, string>> = {
  'zh-hans': 'zh_cn',
  'zh-cn': 'zh_cn',
  'zh-sg': 'zh_cn',
  'zh-hant': 'zh_tw',
  'zh-tw': 'zh_tw',
  'zh-hk': 'zh_tw',
  'pt-br': 'pt_br',
  'pt-pt': 'pt_pt',
  'en-gb': 'en_gb',
  'es-mx': 'es_mx',
  'es-es': 'es_es',
}

export function isLegacyLanguageFormat(minecraftVersion?: string): boolean {
  if (!minecraftVersion) return false
  const parsed = parseMinecraftVersion(minecraftVersion)
  if (!parsed) return false
  return parsed.major === 1 && parsed.minor < 11
}

export function localeToMinecraftLanguage(
  locale: string,
  minecraftVersion?: string,
): string {
  const normalized = String(locale ?? '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-')
  if (normalized.length === 0) return 'en_us'

  const special = SPECIAL_LOCALES[normalized]
  const parts = normalized.split('-').filter(Boolean)
  const language = parts[0] ?? 'en'
  let code = special
  if (!code) {
    const region =
      parts.find((part) => part.length === 2 && part !== 'hans' && part !== 'hant') ??
      DEFAULT_REGIONS[language] ??
      language
    code = `${language}_${region}`
  }

  if (isLegacyLanguageFormat(minecraftVersion)) {
    const [lang, region = ''] = code.split('_')
    return `${lang}_${region.toUpperCase()}`
  }
  return code.toLowerCase()
}

export function languagePatch(
  locale: string,
  minecraftVersion?: string,
): { lang: string } {
  return { lang: localeToMinecraftLanguage(locale, minecraftVersion) }
}
