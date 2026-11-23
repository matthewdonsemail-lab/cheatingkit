const tools = [
  {
    name: 'Log',
    description: 'Let your agent be able to then become you.',
    href: 'https://log.listeningkit.com',
  },
]

export default function MoreTools() {
  return (
    <section
      data-slot="products-more"
      data-section="more-products"
      className="grid w-full grid-cols-[minmax(10rem,1fr)_minmax(0,2.5fr)] items-start gap-6 py-10 pr-[clamp(1rem,12vw,12rem)] max-sm:grid-cols-1"
    >
      <h2
        id="more-tools"
        data-slot="label"
        className="m-0 font-mono text-2xl font-bold text-[#fafafa]"
      >
        <button
          type="button"
          data-slot="heading-link"
          data-heading-id="more-tools"
          title="Copy link to this section"
        >
          More tools
        </button>
        <span data-slot="heading-copied" aria-live="polite" data-pagefind-ignore=""></span>
      </h2>
      <div data-slot="body">
        <ul className="m-0 grid list-none gap-6 p-0">
          {tools.map(({ name, description, href }) => (
            <li
              key={name}
              className="grid list-none grid-cols-[48px_minmax(0,1fr)] items-center gap-4 border-l-2 border-transparent p-3 hover:border-[#6b6b6b] hover:bg-[#1a1a1a] focus-within:border-[#6b6b6b]"
            >
              <span data-slot="icon" data-mark="" aria-hidden="true" className="grid h-12 w-12 place-items-center border border-[#2a2a2a] bg-[#1f1f1f]">
                <img src="/listeningkit-logo.svg" width="24" height="24" alt="" aria-hidden="true" className="block h-6 w-6" />
              </span>
              <span data-slot="text" className="flex flex-col gap-0.5">
                <a href={href} data-slot="name" className="font-mono text-[0.9375rem] text-[#fafafa]">
                  {name}
                </a>
                <span data-slot="description" className="font-sans text-sm leading-normal text-[#aeaeae]">
                  {description}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
