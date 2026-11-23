import { docsHref, headingId, pages } from './pages.js'

const components = {
  h1: (props) => <h1 {...props} />,
  h2: ({ children, ...props }) => <h2 id={headingId(String(children))} {...props}>{children}</h2>,
  table: (props) => <div className="docs-table-scroll" tabIndex={0}><table {...props} /></div>,
}

export default function DocsArticle({ page, index }) {
  if (!page) {
    return (
      <article className="docs-article">
        <h1>Page not found</h1>
        <p>This docs page does not exist. <a href="/docs">Go to the introduction</a>.</p>
      </article>
    )
  }

  return (
    <article className="docs-article">
      <page.Content components={components} />
      <footer className="docs-article-footer">
        <nav className="docs-pagination" aria-label="Page navigation">
          {pages[index - 1] ? (
            <a href={docsHref(pages[index - 1].slug)} rel="prev"><small>Previous</small>{pages[index - 1].title}</a>
          ) : <span />}
          {pages[index + 1] && (
            <a href={docsHref(pages[index + 1].slug)} rel="next"><small>Next</small>{pages[index + 1].title}</a>
          )}
        </nav>
      </footer>
    </article>
  )
}
