import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathExists, readTextFile } from '../atomic'
import { describeError, getDefaultLogger, type Logger } from '../logger'
import {
  isHardLinked,
  linkFile,
  optionsPaths,
  unlinkFile,
  type LinkFileResult,
} from './hardlink'
import { languagePatch } from './language'
import { mergeOptions, parseOptions, type OptionDocument, type OptionValue } from './options'
import { readEula, readServerProperties, writeEula, writeServerProperties } from './server'
import {
  readShaderOptions,
  shaderState,
  writeShaderOptions,
  type ShaderOptions,
  type ShaderWriteResult,
} from './shader'
import { writeGameFile } from './fileio'
import { GameSettingsWatcher, type GameSettingsListener } from './watcher'

export interface GameSettingsServiceOptions {
  logger?: Logger
}

export interface OptionsRead {
  file: string
  text: string
  document: OptionDocument
}

export interface OptionsWriteResult {
  file: string
  changed: boolean
  diff: Record<string, OptionValue>
  text: string
  document: OptionDocument
  writeMode?: 'atomic' | 'in-place'
}

export interface EnsureOptionsResult {
  file: string
  created: boolean
  reason?: 'already-exists' | 'mod-managed'
  text?: string
  document?: OptionDocument
  language?: string
}

export interface EnsureOptionsOptions {
  locale: string
  minecraftVersion?: string
  eol?: '\n' | '\r\n'
}

function defaultEol(): '\n' | '\r\n' {
  return process.platform === 'win32' ? '\r\n' : '\n'
}

async function statOrUndefined(file: string) {
  try {
    return await stat(file)
  } catch (error) {
    // A missing options.txt is a normal state for a new instance.
    getDefaultLogger().child('settings').debug('options.txt info unavailable', { file, error: describeError(error) })
    return undefined
  }
}

export class GameSettingsService {
  readonly #logger?: Logger

  constructor(options: GameSettingsServiceOptions = {}) {
    this.#logger = options.logger
  }

  optionsPath(instanceDir: string): string {
    return join(instanceDir, 'options.txt')
  }

  async readOptions(instanceDir: string): Promise<OptionsRead | undefined> {
    const file = this.optionsPath(instanceDir)
    const text = await readTextFile(file)
    if (text === undefined) return undefined
    return { file, text, document: parseOptions(text) }
  }

  async editOptions(
    instanceDir: string,
    patch: Record<string, OptionValue | undefined>,
    options: { eol?: '\n' | '\r\n'; finalNewline?: boolean } = {},
  ): Promise<OptionsWriteResult> {
    const file = this.optionsPath(instanceDir)
    const text = (await readTextFile(file)) ?? ''
    const merged = mergeOptions(text, patch, {
      eol: options.eol ?? defaultEol(),
      ...(options.finalNewline !== undefined ? { finalNewline: options.finalNewline } : {}),
    })
    let writeMode: 'atomic' | 'in-place' | undefined
    if (merged.changed) {
      writeMode = await writeGameFile(file, merged.text)
      this.#logger?.info('Game options saved', {
        file,
        changed: Object.keys(merged.diff),
        writeMode,
      })
    }
    return {
      file,
      changed: merged.changed,
      diff: merged.diff,
      text: merged.text,
      document: merged.document,
      ...(writeMode ? { writeMode } : {}),
    }
  }

  async ensureOptions(
    instanceDir: string,
    options: EnsureOptionsOptions,
  ): Promise<EnsureOptionsResult> {
    const file = this.optionsPath(instanceDir)
    const existing = await readTextFile(file)
    if (existing !== undefined) {
      return {
        file,
        created: false,
        reason: 'already-exists',
        text: existing,
        document: parseOptions(existing),
      }
    }
    const yosbr = join(instanceDir, 'config', 'yosbr', 'options.txt')
    const defaultOptions = join(instanceDir, 'config', 'defaultoptions')
    if ((await pathExists(yosbr)) || (await pathExists(defaultOptions))) {
      return { file, created: false, reason: 'mod-managed' }
    }

    const patch = languagePatch(options.locale, options.minecraftVersion)
    const merged = mergeOptions('', patch, {
      eol: options.eol ?? defaultEol(),
      finalNewline: true,
    })
    await writeGameFile(file, merged.text)
    return {
      file,
      created: true,
      text: merged.text,
      document: merged.document,
      language: patch.lang,
    }
  }

  async isOptionsLinked(rootDir: string, instanceDir: string): Promise<boolean> {
    const paths = optionsPaths(rootDir, instanceDir)
    return isHardLinked(paths.root, paths.instance)
  }

  async linkOptions(
    rootDir: string,
    instanceDir: string,
    options: { force?: boolean } = {},
  ): Promise<LinkFileResult> {
    const paths = optionsPaths(rootDir, instanceDir)
    const result = await linkFile(paths.root, paths.instance, options)
    this.#logger?.info('Game options linked', {
      root: paths.root,
      instance: paths.instance,
      alreadyLinked: result.alreadyLinked,
    })
    return result
  }

  async unlinkOptions(rootDir: string, instanceDir: string): Promise<boolean> {
    const paths = optionsPaths(rootDir, instanceDir)
    const unlinked = await unlinkFile(paths.instance)
    this.#logger?.info('Game options unlinked', {
      root: paths.root,
      instance: paths.instance,
      unlinked,
    })
    return unlinked
  }

  async optionsFileInfo(instanceDir: string): Promise<{ exists: boolean; linkedCount: number }> {
    const info = await statOrUndefined(this.optionsPath(instanceDir))
    return { exists: Boolean(info), linkedCount: info?.nlink ?? 0 }
  }

  async readShader(instanceDir: string): Promise<ShaderOptions | undefined> {
    return readShaderOptions(instanceDir)
  }

  async shaderState(instanceDir: string): Promise<{ shaderPack: string; enableShaders: boolean }> {
    return shaderState(await readShaderOptions(instanceDir))
  }

  async editShader(
    instanceDir: string,
    patch: Parameters<typeof writeShaderOptions>[1],
  ): Promise<ShaderWriteResult> {
    const result = await writeShaderOptions(instanceDir, patch)
    if (result.changed) this.#logger?.info('Shader options saved', { file: result.file, diff: result.diff })
    return result
  }

  async readServer(serverDir: string) {
    return readServerProperties(serverDir)
  }

  async writeServer(serverDir: string, patch: Record<string, string | undefined>) {
    const result = await writeServerProperties(serverDir, patch)
    if (result.changed) this.#logger?.info('Server properties saved', { file: result.file, diff: result.diff })
    return result
  }

  readEula(serverDir: string): Promise<boolean | undefined> {
    return readEula(serverDir)
  }

  writeEula(serverDir: string, accepted: boolean): Promise<string> {
    return writeEula(serverDir, accepted)
  }

  watch(instanceDir: string, listener: GameSettingsListener): GameSettingsWatcher {
    return new GameSettingsWatcher(instanceDir, listener, this.#logger).start()
  }
}
