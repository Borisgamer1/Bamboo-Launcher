export type Lang = 'de' | 'en'

export function t(lang: Lang, de: string, en: string): string {
  return lang === 'de' ? de : en
}

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ')
}
