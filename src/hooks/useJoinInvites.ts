import { useCallback, useEffect, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { JoinOffer } from '../electron'
import type { TabType } from '../components/Sidebar'
import type { LanguageType } from '../lib/translations'
import type { ToastMessage } from '../components/Toast'

interface UseJoinInvitesOptions {
  setActiveTab: Dispatch<SetStateAction<TabType>>
  lang: LanguageType
  addToast: (toast: Omit<ToastMessage, 'id'>) => void
}

export interface JoinInvitesState {
  offer: JoinOffer | null
  clear: () => void
}

export function useJoinInvites({ setActiveTab, lang, addToast }: UseJoinInvitesOptions): JoinInvitesState {
  const [offer, setOffer] = useState<JoinOffer | null>(null)

  useEffect(() => {
    const unsubscribe = window.electronAPI?.join.onInvite?.((payload) => {
      void (async () => {
        try {
          const prepared = await window.electronAPI?.join.prepare?.(payload)
          if (prepared?.ok) {
            setOffer(prepared.offer)
            setActiveTab('multiplayer')
            return
          }
          addToast({
            type: 'error',
            message:
              (prepared && 'message' in prepared ? prepared.message : '') ||
              (lang === 'de' ? 'Link ungültig.' : 'Invalid link.'),
          })
        } catch (error) {
          addToast({ type: 'error', message: (error as Error).message })
        }
      })()
    })
    return () => { unsubscribe?.() }
  }, [addToast, lang, setActiveTab])

  const clear = useCallback(() => setOffer(null), [])

  return { offer, clear }
}
