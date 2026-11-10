import { useState } from 'react'

/**
 * Non-component dialog surface: the background lock stack, the shared button
 * styles and the last-defined hook. Kept out of Dialog.tsx so that Fast Refresh
 * sees a component-only module.
 */

const openStack: symbol[] = []
let inertHost: HTMLElement | null = null

export function lockBackground(token: symbol): void {
  openStack.push(token)
  if (openStack.length > 1) return
  inertHost = document.getElementById('root')
  inertHost?.setAttribute('inert', '')
}

export function unlockBackground(token: symbol): void {
  const index = openStack.indexOf(token)
  if (index >= 0) openStack.splice(index, 1)
  if (openStack.length) return
  inertHost?.removeAttribute('inert')
  inertHost = null
}

export function isDialogOpen(): boolean {
  return openStack.length > 0
}

export function isTopDialog(token: symbol): boolean {
  return openStack[openStack.length - 1] === token
}

export function useLastDefined<T>(value: T | null | undefined): T | null {
  const [last, setLast] = useState<T | null>(value ?? null)
  if (value != null && value !== last) {
    setLast(value)
  }
  return value ?? last
}

export const dialogButton = {
  secondary:
    'h-8 px-3 rounded-[10px] border border-stroke bg-surface text-small font-medium text-ink hover:bg-hover transition-[color,background-color,border-color] cursor-pointer',
  accent:
    'h-8 px-3 rounded-[10px] bg-accent text-small font-medium text-accent-contrast hover:bg-accent-hover transition-[color,background-color] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed',
  danger:
    'h-8 px-3 rounded-[10px] bg-danger text-small font-medium text-accent-contrast hover:bg-danger/90 transition-[color,background-color] cursor-pointer',
  info: 'h-8 px-3 rounded-[10px] bg-info text-small font-medium text-accent-contrast hover:bg-info/90 transition-[color,background-color] cursor-pointer disabled:opacity-50',
}
