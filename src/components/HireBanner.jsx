export default function HireBanner() {
  return (
    <aside
      data-section="hireBanner"
      aria-label="Help with AI refusals"
      className="mb-0 mt-5 mx-0 flex w-fit max-w-full flex-wrap items-center justify-start gap-x-3 gap-y-2 self-start border-0 bg-[#54d483] px-3 py-1.5 font-mono text-xs leading-[1.3] tracking-[-0.01em] text-[#0c0c0c]"
    >
      <span data-slot="message" data-banner-copy="desktop" className="min-w-0 whitespace-normal">
        Is your AI refusing to do the work? We might be able to help. Watch this quick video to see if we can help.
      </span>
      <span data-slot="message" data-banner-copy="mobile" className="min-w-0 whitespace-normal">
        AI refusing the work? See how we can help.
      </span>
    </aside>
  )
}
