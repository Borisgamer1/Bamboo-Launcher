import { useCallback, useState } from 'react'
import type { LogAnalysisResult } from '../electron'

export interface LogAnalysesState {
  analyses: Record<string, LogAnalysisResult>
  clear: (folderName: string, instanceId: string) => void
  reanalyze: (key: string, instanceId: string) => Promise<LogAnalysisResult | null>
}

export function useLogAnalyses(): LogAnalysesState {
  const [analyses, setAnalyses] = useState<Record<string, LogAnalysisResult>>({})

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
