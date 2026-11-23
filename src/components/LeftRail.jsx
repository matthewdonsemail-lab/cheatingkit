const links = [
  { n: 1, label: 'Docs', href: '/docs' },
  { n: 2, label: 'CheatingKit', href: '/' },
  { n: 3, label: 'FAQ', href: '#faq' },
]

export default function LeftRail() {
  return (
    <aside
      data-layout="list"
      aria-label="Site navigation"
      className="fixed inset-y-0 left-0 z-20 box-border flex w-[var(--rail-w)] flex-col justify-start gap-8 overflow-y-auto bg-[#0c0c0c] p-[var(--page-pad)]"
    >
      <div data-slot="secondary" className="m-0 self-auto p-0">
        <nav data-component="secondary-nav" aria-label="Secondary">
          <ul className="m-0 flex list-none flex-col gap-2 p-0 text-[15px]">
            {links.map(({ n, label, href }) => (
              <li key={n}>
                <a href={href} aria-current={n === 2 ? 'page' : undefined} className="text-[15px]">
                  [{n}] {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
      <div data-slot="main" className="m-0 self-auto p-0">
        <div data-component="wordmark" className="font-mono text-[15px]">
          cheatingkit
        </div>
      </div>
    </aside>
  )
}
