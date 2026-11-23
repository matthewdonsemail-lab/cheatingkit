import { useState } from 'react'

const items = [
  {
    q: 'What is CheatingKit?',
    a: 'An open-source framework built on top of Morluto’s Reverse Engineer Anything. It is designed to defeat the refusals frontier models throw up when you try to reverse engineer something.',
  },
  {
    q: 'What is it for?',
    a: 'Executables, private software and games. You point it at a binary, a closed piece of software, or a game, and it breaks the thing down.',
  },
  {
    q: 'How does it work?',
    a: 'Small local CPU models steer the frontier model into the right context before it answers, so it stops refusing a task it can already do.',
  },
  {
    q: 'Where did it come from?',
    a: 'We built it while building an open-source go-to-market agency. We did this first with social media clients and the browser, and now with executables and DLLs.',
  },
  {
    q: 'Is it free?',
    a: 'Yes. It is open source. We are available for hire to help you make your models do the tasks they are currently refusing.',
  },
]

function FaqItem({ q, a }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="py-4">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center justify-between gap-4 border-0 bg-none p-0 text-left font-mono text-[15px] text-[#fafafa]"
      >
        <span>{q}</span>
        <span aria-hidden="true">{open ? '−' : '+'}</span>
      </button>
      {open && <p className="mb-0 mt-3 font-sans text-[15px] leading-normal text-[#aeaeae]">{a}</p>}
    </div>
  )
}

export default function Faq() {
  return (
    <section
      id="faq"
      data-section="faq"
      className="grid w-full grid-cols-[minmax(10rem,1fr)_minmax(0,2.5fr)] items-start gap-6 py-10 pr-[clamp(1rem,12vw,12rem)] max-sm:grid-cols-1"
    >
      <h2 className="m-0 font-mono text-2xl font-bold text-[#fafafa]">FAQ</h2>
      <div className="min-w-0">
        {items.map((item) => (
          <FaqItem key={item.q} {...item} />
        ))}
      </div>
    </section>
  )
}
