import { useCallback, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { TabType } from '../components/Sidebar'
import type { Instance } from '../components/InstancesView'

interface UseAppNavigationOptions {
  instances: Instance[]
}

export interface AppNavigationState {
  activeTab: TabType
  setActiveTab: Dispatch<SetStateAction<TabType>>
  handleSetActiveTab: (tab: TabType) => void
  searchQuery: string
  modBrowserInstanceId: string | null
  /** Zählt jeden Aufruf: erzwingt einen neuen Browser-Aufbau samt Tab-Wunsch. */
  modBrowserEntryToken: number
  openModBrowserForInstance: (instanceId: string) => void
  clearModBrowser: () => void
  selectedInstanceOverride: string | null
  clearSelectedInstanceOverride: () => void
  instancesListToken: number
}

export function useAppNavigation({ instances }: UseAppNavigationOptions): AppNavigationState {
  const [activeTab, setActiveTab] = useState<TabType>('home')
  const [modBrowserInstanceId, setModBrowserInstanceId] = useState<string | null>(null)
  const [modBrowserEntryToken, setModBrowserEntryToken] = useState(0)
  const [lastSelectedInstanceId, setLastSelectedInstanceId] = useState<string | null>(null)
  const [selectedInstanceOverride, setSelectedInstanceOverride] = useState<string | null>(null)
  const [instancesListToken, setInstancesListToken] = useState(0)
  const searchQuery = ''

  const handleSetActiveTab = useCallback((tab: TabType) => {
    // Clicking the active Instances entry is the user's way back to the list,
    // even when the detail view was opened through the mod browser.
    if (tab === 'singleplayer' && activeTab === 'singleplayer') {
      setSelectedInstanceOverride(null)
      setLastSelectedInstanceId(null)
      setInstancesListToken((token) => token + 1)
      return
    }
    if (tab === 'mods' && activeTab === 'mods' && modBrowserInstanceId) {
      setModBrowserInstanceId(null)
      setLastSelectedInstanceId(null)
      return
    }
    if (tab === 'singleplayer' && activeTab === 'mods' && lastSelectedInstanceId) {
      const found = instances.find((instance) => instance.id === lastSelectedInstanceId)
      setSelectedInstanceOverride(found ? lastSelectedInstanceId : null)
      setLastSelectedInstanceId(null)
    } else if (tab !== 'singleplayer') {
      setSelectedInstanceOverride(null)
      if (activeTab === 'mods') setLastSelectedInstanceId(null)
    }
    setActiveTab(tab)
  }, [activeTab, instances, lastSelectedInstanceId, modBrowserInstanceId])

  const openModBrowserForInstance = useCallback((instanceId: string) => {
    setModBrowserInstanceId(instanceId)
    setLastSelectedInstanceId(instanceId)
    // Jeder Klick ist ein neuer Besuch: Der Browser wird neu aufgebaut, damit
    // der gewünschte Inhaltstyp auch bei derselben Instanz wieder greift.
    // Ohne diesen Zähler bliebe eine zweite Öffnung auf dem zuletzt gesehenen
    // Tab stehen, weil nur der erste Aufbau den Wunsch einliest.
    setModBrowserEntryToken((token) => token + 1)
    setActiveTab('mods')
  }, [])

  const clearModBrowser = useCallback(() => {
    setModBrowserInstanceId(null)
  }, [])

  const clearSelectedInstanceOverride = useCallback(() => {
    setSelectedInstanceOverride(null)
  }, [])

  return {
    activeTab,
    setActiveTab,
    handleSetActiveTab,
    searchQuery,
    modBrowserInstanceId,
    modBrowserEntryToken,
    openModBrowserForInstance,
    clearModBrowser,
    selectedInstanceOverride,
    clearSelectedInstanceOverride,
    instancesListToken,
  }
}
