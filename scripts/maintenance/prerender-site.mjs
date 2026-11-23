import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { createServer } from 'vite'

const root = resolve(import.meta.dirname, '../..')
const dist = join(root, 'dist')
const template = readFileSync(join(dist, 'index.html'), 'utf8')
const origin = 'https://cheatingkit.com'
const vite = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })

function escapeHtml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function setMeta(html, name, value, property = false) {
  const attribute = property ? 'property' : 'name'
  const pattern = new RegExp(`(<meta ${attribute}="${name}" content=")[^"]*(" \\/>)`)
  return html.replace(pattern, `$1${escapeHtml(value)}$2`)
}

function writePage(path, page, App) {
  globalThis.window = { location: { pathname: path } }
  const title = page ? `${page.title} | CheatingKit Docs` : 'CheatingKit | Open source framework for reverse engineering agents'
  const description = page?.description || 'CheatingKit indexes local Claude Code, Codex, and Hermes sessions so agents can recover context and continue technical work.'
  const url = `${origin}${path}`
  let html = template.replace('<div id="root"></div>', `<div id="root">${renderToString(createElement(App))}</div>`)
  html = html.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`)
  html = html.replace(/(<link rel="canonical" href=")[^"]*(" \/>)/, `$1${url}$2`)
  html = setMeta(html, 'description', description)
  html = setMeta(html, 'og:url', url, true)
  html = setMeta(html, 'og:title', title, true)
  html = setMeta(html, 'og:description', description, true)
  html = setMeta(html, 'twitter:title', title)
  html = setMeta(html, 'twitter:description', description)
  const destination = path === '/' ? join(dist, 'index.html') : join(dist, path.slice(1), 'index.html')
  mkdirSync(resolve(destination, '..'), { recursive: true })
  writeFileSync(destination, html)
}

try {
  const [{ default: App }, { pages, docsHref }] = await Promise.all([
    vite.ssrLoadModule('/src/App.jsx'),
    vite.ssrLoadModule('/src/components/docs/pages.js'),
  ])
  writePage('/', null, App)
  for (const page of pages) writePage(docsHref(page.slug), page, App)
  const urls = ['/', ...pages.map((page) => docsHref(page.slug))]
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((path) => `  <url><loc>${origin}${path}</loc></url>`).join('\n')}\n</urlset>\n`
  writeFileSync(join(dist, 'sitemap.xml'), sitemap)
  console.log(`Prerendered ${urls.length} pages and sitemap.xml`)
} finally {
  await vite.close()
  delete globalThis.window
}
