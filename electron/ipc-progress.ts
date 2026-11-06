import type { Logger } from './logger'

interface ProgressEvent {
  sender: { send(channel: string, payload: unknown): void }
}

/**
 * The footer bar lives in App, so its progress must keep flowing when the screen
 * that started the task is gone. A closed window may not fail the task.
 */
export function sendBackgroundTaskProgress(
  event: ProgressEvent,
  task: unknown,
  logger?: Logger,
  context = 'background task',
): void {
  try {
    event.sender.send('background-task-progress', task)
  } catch (error) {
    logger?.debug(`${context}: progress could not be sent`, { error: (error as Error).message })
  }
}
