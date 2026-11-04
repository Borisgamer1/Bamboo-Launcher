/**
 * Third-party mod descriptions: markdown identifiers and links must survive,
 * while everything executable or stylistic must not. This exercises the same
 * `renderDescription` function ModsView feeds to dangerouslySetInnerHTML, with
 * DOMPurify bound to a jsdom window.
 */
const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')
const { pathToFileURL } = require('node:url')
const createDOMPurify = require('dompurify')
const { JSDOM } = require('jsdom')

const ROOT = path.join(__dirname, '..')
const MODULE = pathToFileURL(path.join(ROOT, 'src', 'lib', 'descriptionHtml.ts')).href
const DOMPurify = createDOMPurify(new JSDOM('').window)

let sanitize

async function render(text, format = 'markdown') {
  const { createDescriptionSanitizer, renderDescription } = await import(MODULE)
  if (!sanitize) sanitize = createDescriptionSanitizer(DOMPurify)
  return renderDescription(text, format, sanitize)
}

test('descriptions: underscore identifiers and CDN URLs survive markdown', async () => {
  const html = await render(
    [
      'cached_images stays intact',
      '',
      '![preview](https://cdn.modrinth.com/data/cached_images/a_b.png)',
      '',
      'https://cdn.modrinth.com/data/cached_images/bare.png',
    ].join('\n'),
  )

  assert.match(html, /cached_images stays intact/, 'an intraword underscore is not emphasis')
  assert.doesNotMatch(html, /<em>/, 'no emphasis may be manufactured inside the identifier')
  assert.match(
    html,
    /<img src="https:\/\/cdn\.modrinth\.com\/data\/cached_images\/a_b\.png" alt="preview">/,
    'the image URL keeps its underscores',
  )
  assert.match(
    html,
    /<a href="https:\/\/cdn\.modrinth\.com\/data\/cached_images\/bare\.png">/,
    'a bare image URL survives as a link',
  )
})

test('descriptions: hostile markdown cannot execute or style the page', async () => {
  const html = await render(
    [
      '<script>window.__pwned = true</script>',
      '',
      '<img src="x" onerror="window.__pwned = true">',
      '',
      '<a href="javascript:window.__pwned = true">click</a>',
      '',
      '<a href="data:text/html,<script>alert(1)</script>">data</a>',
      '',
      '<iframe src="https://evil.test"></iframe>',
      '',
      '<div style="background:url(javascript:1)">styled</div>',
      '',
      '<div class="fixed inset-0 z-50 bg-black">overlay</div>',
      '',
      '[inline](javascript:alert(1))',
    ].join('\n'),
  )

  assert.doesNotMatch(html, /<script/i)
  assert.doesNotMatch(html, /<iframe/i)
  assert.doesNotMatch(html, /onerror/i)
  assert.doesNotMatch(html, /javascript:/i)
  assert.doesNotMatch(html, /data:text\/html/i)
  assert.doesNotMatch(html, /style=/i)
  assert.doesNotMatch(
    html,
    /class=/i,
    'an allowlisted class could lay a fixed overlay over the whole launcher',
  )
  assert.match(html, /click/)
  assert.match(html, /styled/)
  assert.match(html, /overlay/)
})

test('descriptions: CurseForge HTML is reduced to the same allowlist', async () => {
  const html = await render(
    [
      '<p onclick="window.__pwned = true">ok</p>',
      '<img src="https://cdn.example/data/cached_images/x_y.png" style="width:1px">',
      '<script>window.__pwned = true</script>',
      '<h2>Heading</h2>',
    ].join(''),
    'html',
  )

  assert.match(html, /<p>ok<\/p>/)
  assert.match(html, /cached_images\/x_y\.png/, 'image URLs are not mangled or dropped')
  assert.match(html, /<h2>Heading<\/h2>/)
  assert.doesNotMatch(html, /onclick|style=|<script/i)
})

test('descriptions: only http(s), mailto, fragments and local paths are linkable', async () => {
  const html = await render(
    [
      '<a href="//evil.test/x">protocol relative</a>',
      '<a href="/local/path_x">root relative</a>',
      '<a href="./rel/path_y">relative</a>',
      '<a href="mailto:hello@example.com">mail</a>',
      '<img src="data:image/png;base64,AAAA">',
    ].join(''),
    'html',
  )

  assert.doesNotMatch(html, /evil\.test/)
  assert.doesNotMatch(html, /data:image/)
  assert.match(html, /href="\/local\/path_x"/)
  assert.match(html, /href="\.\/rel\/path_y"/)
  assert.match(html, /mailto:hello@example\.com/)
})
