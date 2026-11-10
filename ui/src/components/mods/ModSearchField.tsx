import React, { useEffect, useState } from 'react'
import { Search } from 'lucide-react'
import { SEARCH_DEBOUNCE_MS } from '../../lib/modsBrowser'

/** Search box that owns its draft text and debounces the query upward. */
export const ModSearchField = React.memo(function ModSearchField({
  value,
  placeholder,
  onQueryChange,
}: {
  value: string
  placeholder: string
  onQueryChange: (value: string) => void
}) {
  const [text, setText] = useState(value)
  const [syncedValue, setSyncedValue] = useState(value)

  // Adjust the draft when the owner resets the query, without an effect round-trip.
  if (value !== syncedValue) {
    setSyncedValue(value)
    setText(value)
  }

  useEffect(() => {
    if (text === value) return
    const timer = setTimeout(() => onQueryChange(text), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [text, value, onQueryChange])

  return (
    <div className="relative shrink-0">
      <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-secondary" />
      <input
        type="text"
        data-tour="mods-search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-root/40 border border-stroke/80 rounded-2xl py-3 pl-11 pr-4 text-small text-ink placeholder:text-ink-tertiary outline-none transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] focus:border-[color:var(--accent)]/50"
      />
    </div>
  )
})
