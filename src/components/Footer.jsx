const links = [
  { label: 'FAQ', href: '#faq' },
  { label: 'Contributors', href: 'https://github.com/matthewdonsemail-lab/cheatingkit/graphs/contributors' },
  { label: 'Source', href: 'https://github.com/matthewdonsemail-lab/cheatingkit' },
  { label: 'MIT license', href: 'https://opensource.org/license/mit' },
  { label: 'Join the community' },
  { label: 'Follow us on X' },
]

export default function Footer() {
  return (
    <footer className="border-t border-[#242424] py-10 pr-[clamp(1rem,12vw,12rem)]">
      <nav aria-label="Footer">
        <ul className="m-0 flex list-none flex-wrap gap-x-8 gap-y-4 p-0 font-mono text-sm">
          {links.map(({ label, href }) => (
            <li key={label}>
              {href ? (
                <a href={href} className="text-[#aeaeae] no-underline hover:text-[#fafafa] focus-visible:text-[#fafafa]">
                  {label}
                </a>
              ) : (
                <span className="text-[#777]">{label}</span>
              )}
            </li>
          ))}
        </ul>
      </nav>
    </footer>
  )
}
