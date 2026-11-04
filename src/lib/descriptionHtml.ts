import { marked } from 'marked'
import type DOMPurify from 'dompurify'

export interface SanitizeConfig {
  ALLOWED_TAGS: string[]
  ALLOWED_ATTR: string[]
  ALLOWED_URI_REGEXP: RegExp
  ALLOW_DATA_ATTR: boolean
  ALLOW_ARIA_ATTR: boolean
  FORBID_TAGS: string[]
  FORBID_ATTR: string[]
}

export type Sanitizer = (html: string, config: SanitizeConfig) => string

export type DescriptionFormat = 'markdown' | 'html'

/**
 * Third-party descriptions are untrusted. Only structural tags survive, only
 * data-free attributes survive, and URLs must be http(s), mailto, a fragment or
 * a local path. No style, no event handlers, no data:/javascript: URIs.
 */
export const DESCRIPTION_SANITIZE_CONFIG: SanitizeConfig = {
  ALLOWED_TAGS: [
    'p', 'br', 'hr',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'strong', 'em', 'b', 'i', 'u', 's', 'del',
    'code', 'pre', 'blockquote',
    'a', 'img',
    'ul', 'ol', 'li',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'sup', 'sub', 'div', 'span', 'details', 'summary',
  ],
  ALLOWED_ATTR: [
    'href', 'src', 'alt', 'title',
    'width', 'height', 'colspan', 'rowspan', 'start',
  ],
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|#|\/(?!\/)|\.{1,2}\/)/i,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  FORBID_TAGS: [
    'script', 'style', 'iframe', 'object', 'embed',
    'form', 'input', 'button', 'textarea', 'select', 'option',
    'svg', 'math', 'link', 'meta', 'base', 'template',
  ],
  FORBID_ATTR: ['style'],
}

/**
 * Bind the policy to a DOMPurify instance once. DOMPurify permits data: URIs on
 * media tags regardless of ALLOWED_URI_REGEXP, so the attribute hook removes
 * them explicitly instead of relying on the config alone.
 */
export function createDescriptionSanitizer(purify: typeof DOMPurify): Sanitizer {
  purify.addHook('uponSanitizeAttribute', (_node, data) => {
    if (
      (data.attrName === 'src' || data.attrName === 'href') &&
      /^\s*data:/i.test(data.attrValue)
    ) {
      data.keepAttr = false
    }
  })
  return (html, config) => purify.sanitize(html, config)
}

export function markdownToHtml(text: string): string {
  return String(marked.parse(String(text ?? ''), { gfm: true, breaks: false }))
}

export function renderDescription(
  text: string,
  format: DescriptionFormat,
  sanitize: Sanitizer,
): string {
  const html = format === 'markdown' ? markdownToHtml(text) : String(text ?? '')
  return sanitize(html, DESCRIPTION_SANITIZE_CONFIG)
}
