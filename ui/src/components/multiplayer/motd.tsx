import React from 'react'

export const formatMotd = (text: string) => {
  if (!text) return <span className="text-ink-tertiary">No description available</span>

  const parts = text.split(/(§[0-9a-fklmnor])/)
  let currentStyle: React.CSSProperties = {}

  const colorMap: Record<string, string> = {
    '§0': '#000000', '§1': '#0000aa', '§2': '#00aa00', '§3': '#00aaaa',
    '§4': '#aa0000', '§5': '#aa00aa', '§6': '#ffaa00', '§7': '#aaaaaa',
    '§8': '#555555', '§9': '#5555ff', '§a': '#55ff55', '§b': '#55ffff',
    '§c': '#ff5555', '§d': '#ff55ff', '§e': '#ffff55', '§f': '#ffffff',
  }

  return parts.map((part, index) => {
    if (part.startsWith('§')) {
      const code = part.toLowerCase()
      if (colorMap[code]) {
        currentStyle = { ...currentStyle, color: colorMap[code] }
      } else if (code === '§l') {
        currentStyle = { ...currentStyle, fontWeight: 600 }
      } else if (code === '§o') {
        currentStyle = { ...currentStyle, fontStyle: 'italic' }
      } else if (code === '§r') {
        currentStyle = {}
      }
      return null
    }
    return (
      <span key={index} style={{ ...currentStyle }} >
        {part}
      </span>
    )
  })
}
