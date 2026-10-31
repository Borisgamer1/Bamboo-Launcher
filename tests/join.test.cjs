/**
 * P12 join grammar (spec §4.3/§4.11). One table drives the 49-case proof:
 * 15 accepted links, 34 rejections, zero deviations. Size rejects are the only
 * `join.rejected-size` cases; every other rejection is `join.rejected-grammar`.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

const {
  MAX_JOIN_URL_BYTES,
  parseJoinUrl,
  buildInviteUrl,
  buildJoinUrl,
} = require('../dist-electron/join/index.js')

const HOST_253 = ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(61)].join('.')
const HOST_254 = ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(62)].join('.')
const SHA1 = 'a'.repeat(40)

function query(fields) {
  return Object.entries(fields)
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
    .join('&')
}

function joinUrl(fields) {
  return `bamboo-launcher://join?${query(fields)}`
}

function inviteUrl(payload) {
  return `bamboo-launcher://invite?data=${encodeURIComponent(JSON.stringify(payload))}`
}

function exactSizeUrl() {
  const url = buildJoinUrl({
    v: 1,
    host: 'play.example.com',
    pack: `https://cdn.modrinth.com/${'a'.repeat(1915)}`,
    sha1: SHA1,
  })
  assert.equal(Buffer.byteLength(url, 'utf8'), MAX_JOIN_URL_BYTES)
  return url
}

function cases() {
  const exact = exactSizeUrl()
  const pack = (url) => joinUrl({ v: 1, host: 'play.example.com', pack: url, sha1: SHA1 })
  return [
    // 14 valid forms listed in §4.11.
    { name: 'dns', url: joinUrl({ v: 1, host: 'play.example.com' }), accept: true },
    { name: 'ipv4', url: joinUrl({ v: 1, host: '192.168.0.1' }), accept: true },
    { name: 'ipv6', url: joinUrl({ v: 1, host: '[2001:db8::1]' }), accept: true },
    { name: 'pack cdn', url: pack('https://cdn.modrinth.com/data/x/pack.mrpack'), accept: true },
    { name: 'pack github', url: pack('https://github.com/a/b/releases/download/v1/pack.mrpack'), accept: true },
    { name: 'pack raw', url: pack('https://raw.githubusercontent.com/a/b/main/pack.mrpack'), accept: true },
    { name: 'pack forgecdn', url: pack('https://mediafilez.forgecdn.net/files/1/2/pack.zip'), accept: true },
    {
      name: 'invite percent',
      url: buildInviteUrl({ v: 1, host: 'play.example.com', name: '100% Vanilla' }),
      accept: true,
    },
    { name: 'port 1', url: joinUrl({ v: 1, host: 'play.example.com', port: 1 }), accept: true },
    { name: 'port 65535', url: joinUrl({ v: 1, host: 'play.example.com', port: 65535 }), accept: true },
    { name: 'name 64', url: joinUrl({ v: 1, host: 'play.example.com', name: 'n'.repeat(64) }), accept: true },
    { name: 'profile 64', url: joinUrl({ v: 1, host: 'play.example.com', profile: 'p'.repeat(64) }), accept: true },
    { name: 'host 253', url: joinUrl({ v: 1, host: HOST_253 }), accept: true },
    { name: 'url 2048', url: exact, accept: true },

    // Size: exact accepted, one byte more rejected. The exact case is repeated
    // here on purpose so this group is the two-case proof from §4.11.
    { name: 'size exact', url: exact, accept: true },
    {
      name: 'size 2049',
      url: exact.replace('&sha1=', 'a&sha1='),
      accept: false,
      code: 'join.rejected-size',
    },

    // Top-level URL.
    { name: 'userinfo', url: `bamboo-launcher://user:pass@join?${query({ v: 1, host: 'play.example.com' })}`, accept: false },
    { name: 'path', url: `bamboo-launcher://join/extra?${query({ v: 1, host: 'play.example.com' })}`, accept: false },
    { name: 'fragment', url: `${joinUrl({ v: 1, host: 'play.example.com' })}#x`, accept: false },
    { name: 'double question', url: `${joinUrl({ v: 1, host: 'play.example.com' })}?x`, accept: false },

    // Pack allowlist and pairing.
    { name: 'pack http', url: pack('http://cdn.modrinth.com/x'), accept: false },
    { name: 'pack foreign', url: pack('https://example.com/x'), accept: false },
    { name: 'pack suffix', url: pack('https://cdn.modrinth.com.evil.example/x'), accept: false },
    { name: 'pack no sha1', url: joinUrl({ v: 1, host: 'play.example.com', pack: 'https://cdn.modrinth.com/x' }), accept: false },
    { name: 'sha1 no pack', url: joinUrl({ v: 1, host: 'play.example.com', sha1: SHA1 }), accept: false },
    { name: 'sha1 39', url: joinUrl({ v: 1, host: 'play.example.com', pack: 'https://cdn.modrinth.com/x', sha1: 'a'.repeat(39) }), accept: false },
    { name: 'sha1 nonhex', url: joinUrl({ v: 1, host: 'play.example.com', pack: 'https://cdn.modrinth.com/x', sha1: 'g'.repeat(40) }), accept: false },
    { name: 'pack userinfo', url: pack('https://user:pass@cdn.modrinth.com/x'), accept: false },
    { name: 'pack fragment', url: pack('https://cdn.modrinth.com/x#fragment'), accept: false },

    // Host.
    { name: 'bad dns', url: joinUrl({ v: 1, host: 'bad_host' }), accept: false },
    { name: 'ipv4 999', url: joinUrl({ v: 1, host: '999.999.999.999' }), accept: false },
    { name: 'ipv4 01', url: joinUrl({ v: 1, host: '01.2.3.4' }), accept: false },
    { name: 'ipv6 unbracketed', url: joinUrl({ v: 1, host: '2001:db8::1' }), accept: false },
    { name: 'punycode', url: joinUrl({ v: 1, host: 'xn--bcher-kva.example' }), accept: false },
    { name: 'host 254', url: joinUrl({ v: 1, host: HOST_254 }), accept: false },
    { name: 'ipv4 256', url: joinUrl({ v: 1, host: '1.2.3.256' }), accept: false },

    // Parameters.
    { name: 'v missing', url: joinUrl({ host: 'play.example.com' }), accept: false },
    { name: 'v 2', url: joinUrl({ v: 2, host: 'play.example.com' }), accept: false },
    { name: 'unknown', url: joinUrl({ v: 1, host: 'play.example.com', extra: 'x' }), accept: false },
    { name: 'port 0', url: joinUrl({ v: 1, host: 'play.example.com', port: 0 }), accept: false },
    { name: 'port 65536', url: joinUrl({ v: 1, host: 'play.example.com', port: 65536 }), accept: false },
    { name: 'port leading zero', url: joinUrl({ v: 1, host: 'play.example.com', port: '025565' }), accept: false },
    { name: 'name 65', url: joinUrl({ v: 1, host: 'play.example.com', name: 'n'.repeat(65) }), accept: false },
    { name: 'profile 65', url: joinUrl({ v: 1, host: 'play.example.com', profile: 'p'.repeat(65) }), accept: false },

    // Legacy invite: one decode, then schema validation.
    { name: 'invite broken json', url: 'bamboo-launcher://invite?data=%7Bbad', accept: false },
    { name: 'invite v2', url: inviteUrl({ v: 2, host: 'play.example.com' }), accept: false },
    { name: 'invite unknown', url: inviteUrl({ v: 1, host: 'play.example.com', extra: 'x' }), accept: false },
    { name: 'invite pack no sha1', url: inviteUrl({ v: 1, host: 'play.example.com', pack: 'https://cdn.modrinth.com/x' }), accept: false },
    { name: 'invite name 65', url: inviteUrl({ v: 1, host: 'play.example.com', name: 'n'.repeat(65) }), accept: false },
  ]
}

test('P12 §4.11: 49-case grammar proof has 15 accepts and 34 rejects', () => {
  const table = cases()
  assert.equal(table.length, 49, 'the proof table must contain exactly 49 cases')
  let accepted = 0
  let rejected = 0
  const deviations = []
  for (const item of table) {
    const result = parseJoinUrl(item.url)
    if (result.ok) {
      accepted += 1
      if (!item.accept) deviations.push(`${item.name}: expected reject, got accept`)
    } else {
      rejected += 1
      if (item.accept) {
        deviations.push(`${item.name}: expected accept, got ${result.code} (${result.message})`)
      } else if (item.code && result.code !== item.code) {
        deviations.push(`${item.name}: expected ${item.code}, got ${result.code}`)
      }
    }
  }
  console.log(
    `P12 join proof: ${accepted} accepted, ${rejected} rejected, ${deviations.length} deviations, ${table.length} total`,
  )
  assert.deepEqual({ accepted, rejected, deviations }, { accepted: 15, rejected: 34, deviations: [] })
})

test('P12: invite payload is decoded exactly once and preserves percent signs', () => {
  const url = buildInviteUrl({ v: 1, host: 'play.example.com', name: '100% Vanilla', profile: 'profile_1' })
  const parsed = parseJoinUrl(url)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.payload.name, '100% Vanilla')
  assert.equal(parsed.payload.profile, 'profile_1')
  assert.equal(url.includes('%25'), true)
})

test('P12: normalized payload defaults the port and rejects unknown renderer keys', () => {
  const parsed = parseJoinUrl(joinUrl({ v: 1, host: 'play.example.com' }))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.payload.port, 25565)
  assert.equal(parseJoinUrl(joinUrl({ v: 1, host: 'play.example.com', token: 'secret' })).ok, false)
})

test('P12: the 2048-byte limit also applies to the legacy invite form', () => {
  const oversized = `bamboo-launcher://invite?data=${'a'.repeat(2048)}`
  assert.equal(Buffer.byteLength(oversized, 'utf8') > MAX_JOIN_URL_BYTES, true)
  const parsed = parseJoinUrl(oversized)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.code, 'join.rejected-size')
})

test('P12: main.js owns only the protocol seam and preload buffers a flushed link', () => {
  const root = path.join(__dirname, '..')
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  assert.doesNotMatch(main, /pendingDeepLink/)
  assert.doesNotMatch(main, /decodeURIComponent\(data\)/)
  assert.match(main, /getJoinService\(\)\.receive\(url\)/)
  assert.match(main, /bamboo:ui:ready/)
  const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8')
  assert.match(preload, /pendingDeepLinks/)
  assert.match(preload, /bamboo:ui:ready/)
  assert.match(preload, /bamboo:join:confirm/)
})
