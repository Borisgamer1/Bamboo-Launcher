import { useCallback, useEffect, useRef, useState } from 'react'
import type { StatisticsSummary } from '../electron'

export interface StatisticsState {
  summary: StatisticsSummary | null
  loading: boolean
  error: string
  refresh: () => void
}

/**
 * One client for the main-process statistics aggregate. Components render the
 * returned snapshot; they never read the ledger or world files themselves.
 */
export function useStatistics(): StatisticsState {
  const [summary, setSummary] = useState<StatisticsSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const requestRef = useRef(0)

  const load = useCallback(async (requestId: number) => {
    try {
      const next = await window.electronAPI?.statistics.summary?.()
      if (requestRef.current !== requestId) return
      if (!next) {
        setError('not-available')
        setSummary(null)
        return
      }
      setSummary(next)
      setError('')
    } catch {
      if (requestRef.current !== requestId) return
      setError('failed')
    } finally {
      if (requestRef.current === requestId) setLoading(false)
    }
  }, [])

  const refresh = useCallback(() => {
    const requestId = requestRef.current + 1
    requestRef.current = requestId
    setLoading(true)
    setError('')
    void load(requestId)
  }, [load])

  useEffect(() => {
    const requestId = requestRef.current + 1
    requestRef.current = requestId
    void load(requestId)
    return () => {
      requestRef.current += 1
    }
  }, [load])

  return { summary, loading, error, refresh }
}
