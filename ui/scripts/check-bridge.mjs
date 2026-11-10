#!/usr/bin/env node
// Prüft, dass die Tauri-Brücke jedem Command alle Pflichtargumente mitgibt.
// Genau diese Fehlerklasse hat Crash-Analyse und Screenshot-Löschen lahmgelegt:
// der Rust-Command verlangt ein Argument, `invoke` schickt keins, Tauri lehnt
// den Aufruf ab und die UI zeigt nur einen Fehler.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const bridgePath = join(root, 'ui', 'src', 'lib', 'tauriBridge.ts')

function rustFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) files.push(...rustFiles(path))
    else if (path.endsWith('.rs')) files.push(path)
  }
  return files
}

/** Injected by Tauri; they are not part of the JS payload. */
const INJECTED = /\b(AppHandle|State<|WebviewWindow|Window\b|Manager\b|Emitter\b)/

function splitTopLevel(parameters) {
  const parts = []
  let depth = 0
  let current = ''
  for (const character of parameters) {
    if ('<([{'.includes(character)) depth += 1
    if ('>)]}'.includes(character)) depth -= 1
    if (character === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += character
  }
  if (current.trim()) parts.push(current)
  return parts
}

/** Keys of an object literal, including `{ shorthand }` entries. */
function objectKeys(literal) {
  if (!literal) return []
  const inner = literal.trim().replace(/^\{/, '').replace(/\}$/, '')
  return splitTopLevel(inner)
    .map((part) => part.split(':')[0].trim())
    .filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
}

function camelCase(name) {
  return name.replace(/_([a-z0-9])/g, (_, letter) => letter.toUpperCase())
}

function rustCommands() {
  const commands = new Map()
  for (const file of rustFiles(join(root, 'src'))) {
    const source = readFileSync(file, 'utf8')
    const marker = '#[tauri::command]'
    let index = source.indexOf(marker)
    while (index !== -1) {
      const start = source.indexOf('fn ', index)
      const open = source.indexOf('(', start)
      if (start === -1 || open === -1) break
      const name = source.slice(start + 3, open).trim()
      let depth = 0
      let end = open
      for (; end < source.length; end += 1) {
        if (source[end] === '(') depth += 1
        if (source[end] === ')') {
          depth -= 1
          if (depth === 0) break
        }
      }
      const parameters = source.slice(open + 1, end)
      const required = []
      for (const part of splitTopLevel(parameters)) {
        const [rawName, ...typeParts] = part.split(':')
        const parameter = rawName.trim()
        const type = typeParts.join(':').trim()
        if (!parameter || !type) continue
        if (INJECTED.test(type)) continue
        if (type.startsWith('&')) continue
        required.push(camelCase(parameter))
      }
      commands.set(name, { file, required })
      index = source.indexOf(marker, index + marker.length)
    }
  }
  return commands
}

function bridgeCalls() {
  const source = readFileSync(bridgePath, 'utf8')
  const calls = []
  const pattern = /(?:call(?:<[^>]*>)?|send)\('([a-z0-9_]+)'/g
  let match
  while ((match = pattern.exec(source))) {
    const after = source.slice(match.index + match[0].length)
    let args = ''
    if (after.trimStart().startsWith(',')) {
      const rest = after.trimStart().slice(1).trimStart()
      if (rest.startsWith('{')) {
        let depth = 0
        for (let index = 0; index < rest.length; index += 1) {
          if (rest[index] === '{') depth += 1
          if (rest[index] === '}') {
            depth -= 1
            if (depth === 0) {
              args = rest.slice(0, index + 1)
              break
            }
          }
        }
      }
    }
    calls.push({ name: match[1], args })
  }
  return calls
}

const commands = rustCommands()
const calls = bridgeCalls()
const problems = []

for (const call of calls) {
  const command = commands.get(call.name)
  if (!command) {
    problems.push(`"${call.name}" ist in der Brücke, aber kein Tauri-Command.`)
    continue
  }
  const passed = new Set(objectKeys(call.args))
  const missing = command.required.filter((parameter) => !passed.has(parameter))
  if (missing.length > 0) {
    problems.push(
      `"${call.name}" braucht ${missing.join(', ')} – die Brücke schickt ${call.args || 'nichts'}.`,
    )
  }
}

if (problems.length > 0) {
  console.error(`Brücken-Check: ${problems.length} Problem(e)`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(`Brücken-Check: ${calls.length} Aufrufe, ${commands.size} Commands – alle Pflichtargumente gesetzt.`)
