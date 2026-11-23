import { docsHref, pages } from './pages.js'

function Bracket({ active }) {
  return <span className="docs-bracket" aria-hidden="true">[{active ? '−' : ' '}]</span>
}

function DocsNav({ currentSlug }) {
  return (
    <nav className="docs-nav" aria-label="Docs navigation">
      <div className="docs-nav-group">
        <ul>
          {pages.map((item) => (
            <li key={item.slug || 'intro'}>
              <a href={docsHref(item.slug)} className={item.slug.includes('/hooks') ? 'docs-nav-subitem' : item.slug.startsWith('harnesses/') || item.slug.startsWith('models/') ? 'docs-nav-child' : undefined} aria-current={item.slug === currentSlug ? 'page' : undefined}>
                <Bracket active={item.slug === currentSlug} />
                <span>{item.title}</span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  )
}

export default function DocsSidebar({ currentSlug, currentTitle }) {
  return (
    <aside className="docs-sidebar" aria-label="Documentation navigation">
      <div className="docs-lockup">
        <a href="/" className="docs-logo" aria-label="CheatingKit home">C</a>
        <a href="/docs" className="docs-lockup-title">Docs</a>
      </div>
      <div className="docs-desktop-nav"><DocsNav currentSlug={currentSlug} /></div>
      <details className="docs-mobile-nav">
        <summary>{currentTitle || 'Docs'}<span aria-hidden="true">⌄</span></summary>
        <DocsNav currentSlug={currentSlug} />
      </details>
    </aside>
  )
}
