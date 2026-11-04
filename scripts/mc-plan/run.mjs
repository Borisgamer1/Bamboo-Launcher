#!/usr/bin/env node
/**
 * mc_plan v0.2.2 — Autopilot runner.
 *
 * Safe, explicit subcommands. Nothing destructive is implicit:
 *   status                 show branches / worktrees / integration log
 *   init                   snapshot the dirty working tree as autopilot/baseline,
 *                          create autopilot/integration, switch to it
 *   worktree <job-id>      create an isolated worktree for a job
 *   verify <job-id>        build + lint (+ job tests) inside the job worktree
 *   merge <job-id>         merge job branch into integration, run integration gate
 *   remove <job-id>        remove the job worktree and branch (only when merged)
 *
 * Usage:
 *   node scripts/mc-plan/run.mjs status
 *   node scripts/mc-plan/run.mjs init
 *   node scripts/mc-plan/run.mjs worktree j01-net-share-ping
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../..')
const plan = JSON.parse(fs.readFileSync(path.join(here, 'plan.v022.json'), 'utf8'))

const BASELINE = plan.baselineBranch
const INTEGRATION = plan.integrationBranch
const WT_ROOT = plan.worktreeRoot

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
}

function sh(command, cwd = repo, { quiet = false, allowFail = false } = {}) {
  if (!quiet) console.log(c.dim(`$ ${command}  ${cwd === repo ? '' : `(${cwd})`}`))
  const res = spawnSync(command, { cwd, shell: true, stdio: 'inherit', windowsHide: true })
  if (res.status !== 0 && !allowFail) {
    throw new Error(`Command failed (${res.status}): ${command}`)
  }
  return res.status ?? 1
}

function shCapture(command, cwd = repo) {
  const res = spawnSync(command, { cwd, shell: true, encoding: 'utf8', windowsHide: true })
  return { status: res.status ?? 1, out: `${res.stdout ?? ''}${res.stderr ?? ''}`.trim() }
}

function git(args, opts) {
  return sh(`git ${args}`, repo, opts)
}

function gitCapture(args) {
  return shCapture(`git ${args}`, repo)
}

function jobById(id) {
  const job = plan.jobs.find((j) => j.id === id)
  if (!job) {
    const known = plan.jobs.map((j) => j.id).join(', ')
    throw new Error(`Unknown job "${id}". Known jobs: ${known}`)
  }
  return job
}

function worktreePath(job) {
  return path.join(WT_ROOT, job.id)
}

function branchExists(branch) {
  return gitCapture(`rev-parse --verify --quiet refs/heads/${branch}`).status === 0
}

function currentBranch() {
  return gitCapture('branch --show-current').out
}

function ensureExcludes() {
  const excludeFile = path.join(repo, '.git', 'info', 'exclude')
  const header = '# mc_plan autopilot: large binary packs stay out of baseline/worktrees'
  const entries = plan.excludedFromBaseline.map((e) => (e.startsWith('/') ? e : `/${e}`))
  const existing = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf8') : ''
  if (existing.includes(header)) return
  fs.mkdirSync(path.dirname(excludeFile), { recursive: true })
  fs.appendFileSync(excludeFile, `\n${header}\n${entries.join('\n')}\n`)
  console.log(c.green(`exclude: ${entries.join(', ')}`))
}

function ensureNodeModules(target) {
  const link = path.join(target, 'node_modules')
  if (fs.existsSync(link)) return
  const source = path.join(repo, 'node_modules')
  if (!fs.existsSync(source)) {
    console.log(c.yellow('node_modules missing in repo root — run npm install first.'))
    return
  }
  try {
    fs.symlinkSync(source, link, 'junction')
    console.log(c.green(`linked node_modules → ${link}`))
  } catch (err) {
    console.log(c.yellow(`could not link node_modules: ${err.message}`))
  }
}

function copyLocalEnv(target) {
  for (const name of ['.env.development', '.env.production']) {
    const from = path.join(repo, name)
    const to = path.join(target, name)
    if (fs.existsSync(from) && !fs.existsSync(to)) {
      fs.copyFileSync(from, to)
      console.log(c.dim(`copied ${name}`))
    }
  }
}

function cmdStatus() {
  console.log(c.bold('Branch'))
  console.log(`  current: ${currentBranch()}`)
  console.log(`  baseline: ${branchExists(BASELINE) ? c.green('yes') : c.red('no')}`)
  console.log(`  integration: ${branchExists(INTEGRATION) ? c.green('yes') : c.red('no')}`)
  console.log(c.bold('\nWorktrees'))
  console.log(gitCapture('worktree list').out)
  console.log(c.bold('\nJobs'))
  for (const job of plan.jobs) {
    const wt = worktreePath(job)
    const hasWt = fs.existsSync(wt)
    const hasBranch = branchExists(job.branch)
    console.log(
      `  ${job.id.padEnd(30)} wave ${job.wave}  worktree ${hasWt ? c.green('yes') : c.dim('no ')}  branch ${
        hasBranch ? c.green('yes') : c.dim('no ')
      }  ${job.status}`,
    )
  }
  if (branchExists(INTEGRATION)) {
    console.log(c.bold('\nIntegration log'))
    console.log(gitCapture(`log --oneline -10 ${INTEGRATION}`).out)
  }
}

function cmdInit() {
  const unmerged = gitCapture('ls-files -u').out
  if (unmerged) throw new Error('Unmerged paths present. Resolve them before init.')

  ensureExcludes()

  if (!branchExists(BASELINE)) {
    const before = currentBranch()
    console.log(c.cyan(`Snapshotting working tree (current branch: ${before || 'detached'})…`))
    git(`checkout -b ${BASELINE}`)
    git('add -A')
    const staged = gitCapture('diff --cached --name-only')
    if (!staged.out) {
      console.log(c.yellow('Nothing to commit — baseline equals HEAD.'))
    } else {
      git(`commit -m "chore(autopilot): baseline v0.2.2 working tree"`)
    }
  } else {
    console.log(c.green(`baseline branch already exists: ${BASELINE}`))
  }

  if (!branchExists(INTEGRATION)) {
    git(`branch ${INTEGRATION} ${BASELINE}`)
    console.log(c.green(`created ${INTEGRATION} from ${BASELINE}`))
  }
  if (currentBranch() !== INTEGRATION) {
    git(`checkout ${INTEGRATION}`)
  }
  console.log(c.green(`\nReady on ${INTEGRATION}.`))
  cmdStatus()
}

function cmdWorktree(id) {
  const job = jobById(id)
  if (!branchExists(INTEGRATION)) throw new Error(`Missing branch ${INTEGRATION}. Run init first.`)
  const target = worktreePath(job)
  if (fs.existsSync(target)) {
    console.log(c.yellow(`Worktree already exists: ${target}`))
    return
  }
  fs.mkdirSync(WT_ROOT, { recursive: true })
  const branch = branchExists(job.branch) ? job.branch : `-b ${job.branch}`
  git(`worktree add "${target}" ${branch} ${INTEGRATION}`)
  ensureNodeModules(target)
  copyLocalEnv(target)
  console.log(c.green(`\nWorktree ready: ${target}`))
}

function runJobGate(job, cwd) {
  const failures = []
  for (const cmd of plan.gates.job) {
    console.log(c.bold(`\n[gate] ${cmd}`))
    if (sh(cmd, cwd, { allowFail: true }) !== 0) failures.push(cmd)
  }
  if (job.tests?.length) {
    console.log(c.bold('\n[gate] core build + job tests'))
    if (sh('npm run build:core', cwd, { allowFail: true }) !== 0) failures.push('build:core')
    else {
      const files = job.tests.join(' ')
      if (sh(`node --test ${files}`, cwd, { allowFail: true }) !== 0) failures.push(`node --test ${files}`)
    }
  }
  return failures
}

function cmdVerify(id) {
  const job = jobById(id)
  const cwd = worktreePath(job)
  if (!fs.existsSync(cwd)) throw new Error(`No worktree for ${id}. Run worktree first.`)
  const failures = runJobGate(job, cwd)
  if (failures.length) {
    console.log(c.red(`\nVERIFY FAILED (${id}): ${failures.join(' | ')}`))
    process.exit(1)
  }
  console.log(c.green(`\nVERIFY OK (${id})`))
}

function cmdMerge(id) {
  const job = jobById(id)
  if (!branchExists(job.branch)) throw new Error(`Missing branch ${job.branch}.`)
  if (currentBranch() !== INTEGRATION) {
    console.log(c.yellow(`Switching to ${INTEGRATION}…`))
    git(`checkout ${INTEGRATION}`)
  }
  if (fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD'))) {
    throw new Error('A merge is already in progress.')
  }

  const merge = git(`merge --no-ff ${job.branch} -m "merge: ${job.id} (${job.title})"`, {
    allowFail: true,
  })
  if (merge !== 0) {
    console.log(c.red(`\nMERGE CONFLICT (${id}). Resolve manually, then run the gate.`))
    console.log(gitCapture('status --short').out)
    process.exit(1)
  }

  console.log(c.bold('\n[integration gate]'))
  const failures = []
  for (const cmd of plan.gates.integration) {
    if (sh(cmd, repo, { allowFail: true }) !== 0) failures.push(cmd)
  }
  if (failures.length) {
    console.log(c.red(`\nINTEGRATION GATE FAILED after ${id}: ${failures.join(' | ')}`))
    console.log('The merge is kept; fix forward before merging the next job.')
    process.exit(2)
  }
  console.log(c.green(`\nMERGED + GREEN: ${id}`))
}

function cmdRemove(id) {
  const job = jobById(id)
  const target = worktreePath(job)
  if (fs.existsSync(target)) {
    git(`worktree remove "${target}" --force`, { allowFail: true })
  }
  const merged = gitCapture(`branch --merged ${INTEGRATION} --list ${job.branch}`).out
  if (merged) {
    git(`branch -d ${job.branch}`, { allowFail: true })
    console.log(c.green(`removed ${job.branch}`))
  } else {
    console.log(c.yellow(`branch ${job.branch} is not merged — keeping it`))
  }
}

function main() {
  const [cmd, arg] = process.argv.slice(2)
  switch (cmd) {
    case 'status':
      return cmdStatus()
    case 'init':
      return cmdInit()
    case 'worktree':
      return cmdWorktree(arg)
    case 'verify':
      return cmdVerify(arg)
    case 'merge':
      return cmdMerge(arg)
    case 'remove':
      return cmdRemove(arg)
    default:
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0])
      process.exit(cmd ? 1 : 0)
  }
}

try {
  main()
} catch (err) {
  console.error(c.red(`\nERROR: ${err.message}`))
  process.exit(1)
}
