import { isVersionCompatible, matchesLoader } from './compatibility'
import { ModError } from './errors'
import type { ModProvider } from './provider'
import { modsRollback } from './rollback'
import type {
  ModLoader,
  ProviderDependency,
  ProviderId,
  ProviderVersion,
  VersionKey,
} from './types'

export const RESOLVER_VERSION = 1
export const DEFAULT_MAX_NODES = 512
export const DEFAULT_MAX_DEPTH = 64
export const DEFAULT_PROVIDER_TIMEOUT_MS = 5_000

const QUILT_FABRIC_API = 'P7dR8mSH'

export type SkipReason =
  | 'already-installed'
  | 'duplicate-project'
  | 'conflicting-dependency'
  | 'embedded'
  | 'tool'
  | 'include'
  | 'incompatible'
  | 'quilt-fabric-api'

export type UnresolvedReason =
  | 'external-dependency'
  | 'missing-version'
  | 'no-compatible-version'
  | 'version-project-mismatch'

export interface ResolverTarget {
  minecraftVersion: string
  loader: ModLoader
  gameVersionTypeId?: number
}

export interface InstalledProject {
  projectId: string
  versionId?: string
}

export interface PlannedInstall {
  version: ProviderVersion
  depth: number
  requiredBy: VersionKey[]
}

export interface OptionalDependency {
  dependency: ProviderDependency
  parent: VersionKey
}

export interface BlockedDependency {
  projectId?: string
  versionId?: string
  parent: VersionKey
  reason: 'incompatible'
}

export interface UnresolvedDependency {
  dependency: ProviderDependency
  parent: VersionKey
  reason: UnresolvedReason
}

export interface ResolverConflict {
  projectId: string
  plannedVersionId: string
  requestedVersionId?: string
  parent: VersionKey
}

export interface SkippedDependency {
  projectId?: string
  versionId?: string
  parent: VersionKey
  reason: SkipReason
}

export interface ProviderSnapshot {
  provider: ProviderId
  minecraftVersion: string
  loader: ModLoader
  gameVersionTypeId?: number
  resolvedAt: number
}

export interface ResolutionPlan {
  primary: ProviderVersion
  install: PlannedInstall[]
  optional: OptionalDependency[]
  blocked: BlockedDependency[]
  unresolved: UnresolvedDependency[]
  conflicts: ResolverConflict[]
  skipped: SkippedDependency[]
  cycles: string[][]
  primaryBlocked: boolean
  datapackFallbacks: VersionKey[]
  providerSnapshot: ProviderSnapshot
  resolverVersion: number
}

export interface ResolveOptions {
  provider: ModProvider
  projectId: string
  versionId?: string
  target: ResolverTarget
  installed?: InstalledProject[]
  optionalOptIn?: string[]
  maxNodes?: number
  maxDepth?: number
  providerTimeoutMs?: number
  now?: () => number
  /** Escape hatch for the switch itself; defaults to the environment. */
  disabled?: boolean
}

const LOADER_ALIASES: Record<string, string[]> = {
  neoforge: ['neoforge', 'neo'],
  neo: ['neoforge', 'neo'],
}

/** Loader names a target accepts, including the resolver's aliases. */
function acceptedLoadersFor(target: ModLoader): string[] | undefined {
  if (target === 'unknown') return undefined
  const wanted = target === 'legacy' ? 'forge' : target
  return [...new Set([wanted, ...(LOADER_ALIASES[wanted] ?? [])])]
}

function loaderMatches(loaders: string[], target: ModLoader): boolean {
  return matchesLoader(loaders, { acceptedLoaders: acceptedLoadersFor(target) })
}

function matchesTarget(version: ProviderVersion, target: ResolverTarget): boolean {
  const accepted = acceptedLoadersFor(target.loader)
  return isVersionCompatible(version, {
    minecraftVersion: target.minecraftVersion,
    requireVersion: true,
    ...(accepted ? { acceptedLoaders: [...accepted, 'datapack'] } : {}),
  })
}

function publishedAt(version: ProviderVersion): number {
  const parsed = version.publishedAt ? Date.parse(version.publishedAt) : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}

function byNewest(a: ProviderVersion, b: ProviderVersion): number {
  return publishedAt(b) - publishedAt(a) || a.id.localeCompare(b.id)
}

function compareDependencies(a: ProviderDependency, b: ProviderDependency): number {
  const left = `${a.projectId ?? ''}\u0000${a.versionId ?? ''}\u0000${a.fileName ?? ''}\u0000${a.type}`
  const right = `${b.projectId ?? ''}\u0000${b.versionId ?? ''}\u0000${b.fileName ?? ''}\u0000${b.type}`
  return left.localeCompare(right)
}

function versionKey(provider: ProviderId, version: ProviderVersion): VersionKey {
  return { provider, projectId: version.projectId, versionId: version.id }
}

export async function resolveModPlan(options: ResolveOptions): Promise<ResolutionPlan> {
  const { provider, target } = options
  if (options.disabled ?? modsRollback().resolver) {
    throw new ModError(
      'resolver-disabled',
      'The resolver is switched off (BAMBOO_MODS_RESOLVER); use the previous dependency walk',
    )
  }
  const projectId = options.projectId?.trim()
  if (!projectId) throw new ModError('provider-error', 'Resolver needs a project id')
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const providerTimeoutMs = options.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS
  const installed = new Map((options.installed ?? []).map((entry) => [entry.projectId, entry]))
  const optionalOptIn = new Set(options.optionalOptIn ?? [])

  const nodes = new Map<string, PlannedInstall>()
  const versionsByProject = new Map<string, ProviderVersion[]>()
  const pinned = new Map<string, ProviderVersion>()
  const optional: OptionalDependency[] = []
  const blocked: BlockedDependency[] = []
  const incompatibles: Array<{
    parent: VersionKey
    projectId?: string
    versionId?: string
  }> = []
  const datapackFallbacks = new Map<string, VersionKey>()
  const unresolved: UnresolvedDependency[] = []
  const conflicts: ResolverConflict[] = []
  const skipped: SkippedDependency[] = []
  const edges: Array<{ from: ProviderVersion; to: ProviderVersion }> = []
  const visited = new Set<string>()

  const addRequiredBy = (id: string, parent: VersionKey): void => {
    const entry = nodes.get(id)
    if (entry && !entry.requiredBy.some((key) => key.versionId === parent.versionId)) {
      entry.requiredBy.push(parent)
    }
  }

  const noteDatapack = (version: ProviderVersion): void => {
    if (!version.loaders.includes('datapack')) return
    if (loaderMatches(version.loaders, target.loader)) return
    datapackFallbacks.set(version.id, versionKey(provider.id, version))
  }

  const withTimeout = async <T>(work: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new ModError('resolution-limit', 'Provider metadata timed out')),
            providerTimeoutMs,
          )
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  const candidates = async (id: string): Promise<ProviderVersion[]> => {
    const cached = versionsByProject.get(id)
    if (cached) return cached
    const versions = await withTimeout(
      provider.versions(id, {
        minecraftVersion: target.minecraftVersion,
        loader: target.loader,
        ...(target.gameVersionTypeId !== undefined
          ? { gameVersionTypeId: target.gameVersionTypeId }
          : {}),
      }),
    )
    versionsByProject.set(id, versions)
    return versions
  }

  const newestMatching = async (id: string): Promise<ProviderVersion | undefined> =>
    (await candidates(id)).filter((version) => matchesTarget(version, target)).sort(byNewest)[0]

  const pinnedVersion = async (id: string, versionId: string): Promise<ProviderVersion> => {
    const cacheKey = `${id}\u0000${versionId}`
    const cached = pinned.get(cacheKey)
    if (cached) return cached
    const version = await withTimeout(provider.version(id, versionId))
    pinned.set(cacheKey, version)
    return version
  }

  const primary = options.versionId
    ? await pinnedVersion(projectId, options.versionId)
    : await newestMatching(projectId)
  if (!primary) {
    throw new ModError('no-matching-version', `No version of ${projectId} matches the target`)
  }
  if (options.versionId) {
    const requested = await withTimeout(provider.project(projectId))
    if (primary.projectId !== requested.id) {
      throw new ModError(
        'version-project-mismatch',
        `Version ${options.versionId} belongs to ${primary.projectId}, not ${requested.id}`,
      )
    }
  }

  noteDatapack(primary)
  nodes.set(primary.projectId, { version: primary, depth: 0, requiredBy: [] })
  const queue: Array<{ version: ProviderVersion; depth: number }> = [{ version: primary, depth: 0 }]

  for (const record of queue) {
    if (record.depth > maxDepth) {
      throw new ModError('resolution-limit', `Dependency depth exceeded ${maxDepth}`, {
        projectId: record.version.projectId,
      })
    }
    if (visited.has(record.version.id)) continue
    visited.add(record.version.id)
    const parent = versionKey(provider.id, record.version)

    for (const dependency of [...record.version.dependencies].sort(compareDependencies)) {
      const project = dependency.projectId?.trim()
      const parentProject = record.version.projectId

      if (dependency.type === 'optional') {
        if (!project || !optionalOptIn.has(project)) {
          optional.push({ dependency, parent })
          continue
        }
      } else if (dependency.type === 'incompatible') {
        incompatibles.push({
          parent,
          ...(project ? { projectId: project } : {}),
          ...(dependency.versionId ? { versionId: dependency.versionId } : {}),
        })
        continue
      } else if (dependency.type === 'embedded') {
        skipped.push({ ...(project ? { projectId: project } : {}), parent, reason: 'embedded' })
        continue
      } else if (dependency.type === 'tool' || dependency.type === 'include') {
        skipped.push({
          ...(project ? { projectId: project } : {}),
          parent,
          reason: dependency.type,
        })
        continue
      }

      if (!project && !dependency.versionId) {
        unresolved.push({ dependency, parent, reason: 'external-dependency' })
        continue
      }
      if (project === QUILT_FABRIC_API && target.loader === 'quilt') {
        skipped.push({ projectId: project, parent, reason: 'quilt-fabric-api' })
        continue
      }
      if (project && installed.has(project)) {
        const entry = installed.get(project) as InstalledProject
        skipped.push({
          projectId: project,
          ...(entry.versionId ? { versionId: entry.versionId } : {}),
          parent,
          reason: 'already-installed',
        })
        continue
      }
      if (project && nodes.has(project)) {
        const existing = (nodes.get(project) as PlannedInstall).version
        edges.push({ from: record.version, to: existing })
        if (!dependency.versionId || dependency.versionId === existing.id) {
          addRequiredBy(project, parent)
          skipped.push({
            projectId: project,
            versionId: existing.id,
            parent,
            reason: 'duplicate-project',
          })
        } else {
          conflicts.push({
            projectId: project,
            plannedVersionId: existing.id,
            requestedVersionId: dependency.versionId,
            parent,
          })
          skipped.push({
            projectId: project,
            versionId: dependency.versionId,
            parent,
            reason: 'conflicting-dependency',
          })
        }
        continue
      }

      let resolved: ProviderVersion | undefined
      if (dependency.versionId) {
        try {
          resolved = await pinnedVersion(project ?? '', dependency.versionId)
        } catch {
          unresolved.push({ dependency, parent, reason: 'missing-version' })
          continue
        }
        if (project && resolved.projectId !== project) {
          unresolved.push({ dependency, parent, reason: 'version-project-mismatch' })
          continue
        }
      } else if (project) {
        resolved = await newestMatching(project)
      }
      if (!resolved) {
        unresolved.push({ dependency, parent, reason: 'no-compatible-version' })
        continue
      }

      const resolvedProject = resolved.projectId
      if (installed.has(resolvedProject)) {
        const entry = installed.get(resolvedProject) as InstalledProject
        skipped.push({
          projectId: resolvedProject,
          ...(entry.versionId ? { versionId: entry.versionId } : {}),
          parent,
          reason: 'already-installed',
        })
        continue
      }
      const existing = nodes.get(resolvedProject)?.version
      if (existing) {
        edges.push({ from: record.version, to: existing })
        const same = existing.id === resolved.id
        if (same) addRequiredBy(resolvedProject, parent)
        if (!same) {
          conflicts.push({
            projectId: resolvedProject,
            plannedVersionId: existing.id,
            requestedVersionId: resolved.id,
            parent,
          })
        }
        skipped.push({
          projectId: resolvedProject,
          versionId: resolved.id,
          parent,
          reason: same ? 'duplicate-project' : 'conflicting-dependency',
        })
        continue
      }

      const depth = record.depth + 1
      if (depth > maxDepth) {
        throw new ModError('resolution-limit', `Dependency depth exceeded ${maxDepth}`, {
          projectId: resolvedProject,
          parentProject,
        })
      }
      if (nodes.size + 1 > maxNodes) {
        throw new ModError('resolution-limit', `Dependency graph exceeded ${maxNodes} nodes`, {
          projectId: resolvedProject,
        })
      }

      noteDatapack(resolved)
      nodes.set(resolvedProject, { version: resolved, depth, requiredBy: [parent] })
      edges.push({ from: record.version, to: resolved })
      queue.push({ version: resolved, depth })
    }
  }

  let primaryBlocked = false
  for (const edge of [...incompatibles].sort(
    (a, b) =>
      (a.projectId ?? a.versionId ?? '').localeCompare(b.projectId ?? b.versionId ?? '') ||
      (a.versionId ?? '').localeCompare(b.versionId ?? '') ||
      a.parent.versionId.localeCompare(b.parent.versionId),
  )) {
    const plannedNode = edge.projectId ? nodes.get(edge.projectId) : undefined
    const plannedByVersion =
      !plannedNode && edge.versionId
        ? [...nodes.values()].find((node) => node.version.id === edge.versionId)
        : undefined
    const installedEntry = edge.projectId ? installed.get(edge.projectId) : undefined
    const installedByVersion =
      !installedEntry && edge.versionId
        ? [...installed.values()].find((entry) => entry.versionId === edge.versionId)
        : undefined
    if (!plannedNode && !plannedByVersion && !installedEntry && !installedByVersion) {
      skipped.push({
        ...(edge.projectId ? { projectId: edge.projectId } : {}),
        ...(edge.versionId ? { versionId: edge.versionId } : {}),
        parent: edge.parent,
        reason: 'incompatible',
      })
      continue
    }
    const targetProject = edge.projectId
      ?? plannedNode?.version.projectId
      ?? plannedByVersion?.version.projectId
      ?? installedByVersion?.projectId
    blocked.push({
      ...(targetProject ? { projectId: targetProject } : {}),
      ...(edge.versionId ? { versionId: edge.versionId } : {}),
      parent: edge.parent,
      reason: 'incompatible',
    })
    if (targetProject === primary.projectId) primaryBlocked = true
  }

  const blockedProjects = new Set(
    blocked.map((entry) => entry.projectId).filter((id): id is string => Boolean(id)),
  )

  return {
    primary,
    install: [...nodes.values()]
      .filter((entry) => entry.depth > 0 && !blockedProjects.has(entry.version.projectId))
      .sort(
        (a, b) =>
          a.depth - b.depth ||
          a.version.projectId.localeCompare(b.version.projectId) ||
          a.version.id.localeCompare(b.version.id),
      ),
    optional,
    blocked,
    unresolved,
    conflicts,
    skipped,
    cycles: findCycles(nodes, edges),
    primaryBlocked,
    datapackFallbacks: [...datapackFallbacks.values()].sort(
      (a, b) =>
        a.projectId.localeCompare(b.projectId) || a.versionId.localeCompare(b.versionId),
    ),
    providerSnapshot: {
      provider: provider.id,
      minecraftVersion: target.minecraftVersion,
      loader: target.loader,
      ...(target.gameVersionTypeId !== undefined
        ? { gameVersionTypeId: target.gameVersionTypeId }
        : {}),
      resolvedAt: (options.now ?? Date.now)(),
    },
    resolverVersion: RESOLVER_VERSION,
  }
}

function findCycles(
  nodes: Map<string, PlannedInstall>,
  edges: Array<{ from: ProviderVersion; to: ProviderVersion }>,
): string[][] {
  const adjacency = new Map<string, string[]>()
  for (const id of nodes.keys()) adjacency.set(id, [])
  for (const edge of edges) {
    if (!nodes.has(edge.from.projectId) || !nodes.has(edge.to.projectId)) continue
    adjacency.get(edge.from.projectId)?.push(edge.to.projectId)
  }
  for (const targets of adjacency.values()) targets.sort()

  // Tarjan with an explicit frame stack: the recursion a hostile 10.000-node
  // chain would otherwise need is what used to overflow the JS stack.
  let index = 0
  const indices = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const cycles: string[][] = []

  for (const root of [...adjacency.keys()].sort()) {
    if (!indices.has(root)) {
      const frames: Array<{ node: string; next: number }> = [{ node: root, next: 0 }]
      indices.set(root, index)
      low.set(root, index)
      index += 1
      stack.push(root)
      onStack.add(root)

      while (frames.length > 0) {
        const frame = frames[frames.length - 1]
        const targets = adjacency.get(frame.node) ?? []
        if (frame.next < targets.length) {
          const target = targets[frame.next]
          frame.next += 1
          if (!indices.has(target)) {
            indices.set(target, index)
            low.set(target, index)
            index += 1
            stack.push(target)
            onStack.add(target)
            frames.push({ node: target, next: 0 })
          } else if (onStack.has(target)) {
            low.set(
              frame.node,
              Math.min(low.get(frame.node) as number, indices.get(target) as number),
            )
          }
          continue
        }

        frames.pop()
        const node = frame.node
        if (low.get(node) === indices.get(node)) {
          const component = new Set<string>()
          let member: string
          do {
            member = stack.pop() as string
            onStack.delete(member)
            component.add(member)
          } while (member !== node)
          if (component.size > 1) {
            const start = [...component].sort()[0]
            cycles.push(cycleThrough(start, component, adjacency))
          }
        }
        const parent = frames[frames.length - 1]
        if (parent) {
          low.set(parent.node, Math.min(low.get(parent.node) as number, low.get(node) as number))
        }
      }
    }
    if (adjacency.get(root)?.includes(root)) cycles.push([root, root])
  }
  return cycles
}

/** The first path back to `start`; iterative for the same reason as above. */
function cycleThrough(
  start: string,
  component: Set<string>,
  adjacency: Map<string, string[]>,
): string[] {
  const path = [start]
  const seen = new Set(path)
  const frames: Array<{ node: string; next: number }> = [{ node: start, next: 0 }]
  while (frames.length > 0) {
    const frame = frames[frames.length - 1]
    const targets = adjacency.get(frame.node) ?? []
    if (frame.next >= targets.length) {
      frames.pop()
      const dropped = path.pop()
      if (dropped !== undefined && dropped !== start) seen.delete(dropped)
      continue
    }
    const next = targets[frame.next]
    frame.next += 1
    if (!component.has(next)) continue
    if (next === start) return [...path, start]
    if (seen.has(next)) continue
    seen.add(next)
    path.push(next)
    frames.push({ node: next, next: 0 })
  }
  return [...component]
}
