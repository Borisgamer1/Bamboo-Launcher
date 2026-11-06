/** Discord Rich Presence copy stays in one place so launch transitions cannot drift. */
export function createDiscordPresence(
  setActivity: (activity: Record<string, unknown>) => void,
): (status: string, profileName?: string, extraText?: string) => void {
  const defaults = {
    largeImageKey: 'bamboo',
    largeImageText: 'Bamboo Launcher',
  }
  let lastStatus = ''
  let lastDetails = ''

  return (status, profileName, extraText) => {
    let details: string
    let state: string
    let smallImageKey: string | undefined
    let smallImageText: string | undefined

    switch (status) {
      case 'launcher':
        details = 'In Bamboo Launcher'
        state = extraText || 'Browsing profiles & mods'
        break

      case 'starting':
        details = `Starting ${profileName || 'Minecraft'}`
        state = 'Launching...'
        smallImageKey = 'minecraft'
        smallImageText = profileName || ''
        break

      case 'inGame':
        details = `Playing ${profileName || 'Minecraft'}`
        state = extraText || ''
        smallImageKey = 'minecraft'
        smallImageText = profileName || ''
        break

      case 'browsing':
        details = 'Browsing mods'
        state = extraText || 'Mod Browser'
        smallImageKey = 'minecraft'
        smallImageText = 'Mod Browser'
        break

      case 'back':
        details = 'In Bamboo Launcher'
        state = 'Main menu'
        break

      default:
        details = 'In Bamboo Launcher'
        state = ''
        break
    }

    if (details === lastDetails && state === lastStatus) return
    lastDetails = details
    lastStatus = state

    const activity: Record<string, unknown> = {
      details,
      state,
      startTimestamp: ['launcher', 'back'].includes(status) ? undefined : new Date(),
    }

    if (smallImageKey) activity.smallImageKey = smallImageKey
    if (smallImageText) activity.smallImageText = smallImageText

    setActivity({ ...defaults, ...activity })
  }
}
