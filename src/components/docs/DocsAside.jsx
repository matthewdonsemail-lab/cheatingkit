import { useEffect, useRef, useState } from 'react'
import { docsHref, headingId, pages } from './pages.js'

export default function DocsAside({ page }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const shortcut = /Mac/.test(navigator.platform) ? '⌘K' : 'Ctrl K'
  const searchRef = useRef(null)
  const results = pages.filter((item) => `${item.title} ${item.description}`.toLowerCase().includes(query.toLowerCase()))

  useEffect(() => {
    function onKeyDown(event) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen(true)
      }
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    if (open) searchRef.current?.focus()
  }, [open])

  return (
    <aside className="docs-aside" aria-label="Page tools">
      <button type="button" className="docs-search-trigger" onClick={() => setOpen(true)}>
        <span>Search</span><kbd>{shortcut}</kbd>
      </button>
      {page && (
        <nav className="docs-contents" aria-label="On this page">
          <span className="docs-contents-title">Contents</span>
          <ul>
            {page.sections.map((section) => (
              <li key={section}><a href={`#${headingId(section)}`}>{section}</a></li>
            ))}
          </ul>
        </nav>
      )}
      {page && (
        <details className="docs-mobile-contents">
          <summary>Contents<span aria-hidden="true">⌄</span></summary>
          <nav aria-label="On this page">
            <ul>
              {page.sections.map((section) => (
                <li key={section}><a href={`#${headingId(section)}`}>{section}</a></li>
              ))}
            </ul>
          </nav>
        </details>
      )}
      {open && (
        <div className="docs-search-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false) }}>
          <div className="docs-search-dialog" role="dialog" aria-modal="true" aria-label="Search the docs">
            <div className="docs-search-field">
              <input ref={searchRef} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search the docs" aria-label="Search the docs" />
              <button type="button" onClick={() => setOpen(false)}>Esc</button>
            </div>
            {query && (
              <ul className="docs-search-results">
                {results.map((item) => <li key={item.slug || 'intro'}><a href={docsHref(item.slug)}>{item.title}<small>{item.description}</small></a></li>)}
                {results.length === 0 && <li className="docs-search-empty">No matching pages</li>}
              </ul>
            )}
          </div>
        </div>
      )}
    </aside>
  )
}
