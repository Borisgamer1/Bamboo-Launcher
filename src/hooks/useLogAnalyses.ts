import { useCallback, useEffect, useState } from 'react'
import type { LogAnalysisResult } from '../electron'

export interface LogAnalysesState {
  analyses: Record<string, LogAnalysisResult>
  clear: (folderName: string, instanceId: string) => void
  reanalyze: (key: string, instanceId: string) => Promise<LogAnalysisResult | null>
}

export function useLogAnalyses(): LogAnalysesState {
  const [analyses, setAnalyses] = useState<Record<string, LogAnalysisResult>>({})

  useEffect(() => {
    const unsubscribe = window.electronAPI?.logs.onAnalysis?.((result) => {
      void (async () => {
        let key = result.instanceId
        try {
          const records = await window.electronAPI?.instances.list?.()
          const match = records?.find((record) => record.id === result.instanceId)
          if (match?.folderName) key = match.folderName
        } catch {
          // Keep the instance id when the core list is unavailable.
        }
        setAnalyses((prev) => ({ ...prev, [key]: result }))
      })()
    })
    return () => { unsubscribe?.() }
  }, [])

  const clear = useCallback((folderName: string, instanceId: string) => {
    setAnalyses((prev) => {
      if (!(folderName in prev) && !(instanceId in prev)) return prev
      const next = { ...prev }
      delete next[folderName]
      delete next[instanceId]
      return next
    })
  }, [])

  const reanalyze = useCallback(async (key: string, instanceId: string): Promise<LogAnalysisResult | null> => {
    try {
      const result = await window.electronAPI?.logs.analyze?.(instanceId)
      if (result) {
        setAnalyses((prev) => ({ ...prev, [key]: result }))
        return result
      }
    } catch {
      // Preserve the previous analysis when the analyze call fails.
    }
    return null
  }, [])

  return { analyses, clear, reanalyze }
}
