import { existsSync, statSync, unlinkSync } from 'node:fs'
import { resolve, sep } from 'node:path'

export interface ScreenshotDeleteInput {
  rootPath: string
  absolutePath: string
  sourceAbsolutePath?: string
}

export interface ScreenshotDeleteLogger {
  debug(message: string, data?: Record<string, unknown>): void
}

function isUnder(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent + sep)
}

function isFile(target: string): boolean {
  try {
    return existsSync(target) && statSync(target).isFile()
  } catch {
    return false
  }
}

/**
 * Deletes the central screenshot copy and, when it is still inside the
 * launcher's profiles tree, the instance/world original it came from.
 * A path outside the screenshot or profiles roots is never touched.
 */
export function deleteScreenshotFile(
  input: ScreenshotDeleteInput,
  logger?: ScreenshotDeleteLogger,
): boolean {
  const rootPath = resolve(input.rootPath)
  const screenshotsDir = resolve(rootPath, 'screenshots')
  const profilesDir = resolve(rootPath, 'profiles')
  const target = resolve(input.absolutePath)
  if (!isUnder(screenshotsDir, target)) return false

  let deleted = false
  if (existsSync(target)) {
    if (!isFile(target)) return false
    try {
      unlinkSync(target)
      deleted = true
    } catch (error) {
      logger?.debug('screenshot: file could not be deleted', {
        target,
        error: (error as Error).message,
      })
      return false
    }
  }

  const source = input.sourceAbsolutePath
  if (source && source !== input.absolutePath) {
    const sourcePath = resolve(source)
    if (isUnder(profilesDir, sourcePath) && isFile(sourcePath)) {
      try {
        unlinkSync(sourcePath)
        deleted = true
      } catch (error) {
        logger?.debug('screenshot: source copy could not be deleted', {
          source: sourcePath,
          error: (error as Error).message,
        })
      }
    }
  }

  return deleted
}
