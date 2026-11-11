/** Quick Play arguments exist from Minecraft 1.20 on. */
export function supportsQuickPlay(version?: string): boolean {
  const match = /^(\d+)\.(\d+)/.exec(version ?? "")
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return major > 1 || (major === 1 && minor >= 20)
}

/** Splits `host:port`, leaving plain hosts and bracketed IPv6 addresses intact. */
export function parseServerAddress(value: string): { host: string; port: number } {
  const trimmed = value.trim()
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(trimmed)
  if (bracket) {
    return { host: bracket[1], port: Number(bracket[2]) || 25565 }
  }
  const index = trimmed.lastIndexOf(":")
  if (index > 0 && trimmed.indexOf(":") === index) {
    const port = Number(trimmed.slice(index + 1))
    if (Number.isInteger(port) && port > 0 && port < 65536) {
      return { host: trimmed.slice(0, index), port }
    }
  }
  return { host: trimmed, port: 25565 }
}

/** Stable key for a save that belongs to one instance. */
export function worldKey(instanceFolder: string, worldFolder: string): string {
  return `${instanceFolder}/${worldFolder}`
}
