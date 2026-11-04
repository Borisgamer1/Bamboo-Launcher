/**
 * The changelog ships with the build: CHANGELOG.md is bundled as raw text and
 * parsed here, so "what's new" needs no network and no second copy of the text.
 * Each version is documented once per language under localized group headings.
 */
export type ChangelogLang = 'de' | 'en'

export interface ChangelogGroup {
  title: string
  items: string[]
}

export interface ChangelogEntry {
  version: string
  groups: ChangelogGroup[]
}

const GROUP_TITLES: Record<ChangelogLang, readonly string[]> = {
  de: ['Neu', 'Besser', 'Behoben', 'Entfernt'],
  en: ['New', 'Better', 'Fixed', 'Removed'],
}

export function parseChangelog(
  markdown: string,
  version: string,
  lang: ChangelogLang,
): ChangelogEntry | null {
  const lines = markdown.split(/\r?\n/)
  const titles = GROUP_TITLES[lang]

  const start = lines.findIndex((line) => {
    if (!line.startsWith('## ')) return false
    return line.slice(3).trim().split(/\s+/)[0] === version
  })
  if (start < 0) return null

  const groups: ChangelogGroup[] = []
  let current: ChangelogGroup | null = null

  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.startsWith('## ')) break

    if (line.startsWith('### ')) {
      const title = line.slice(4).trim()
      current = titles.includes(title) ? { title, items: [] } : null
      if (current) groups.push(current)
      continue
    }

    if (current && line.startsWith('- ')) {
      const item = line.slice(2).trim()
      if (item) current.items.push(item)
    }
  }

  return { version, groups: groups.filter((group) => group.items.length > 0) }
}
