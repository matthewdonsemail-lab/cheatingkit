export default function Hero() {
  return (
    <section
      data-component="hero"
      data-section="hero"
      data-variant="three-up"
      data-title-size="fitted"
      className="visible mx-0 box-border w-full max-w-none border-t-0 px-0 pt-14 [border-image:none] [--title-chars:23]"
    >
      <h1 className="font-mono">
        Make your model
        <br />
        do the task it refuses.
      </h1>
      <p data-width="3" className="block w-full max-w-none whitespace-normal font-sans">
        <span>
          cheatingkit is an open-source framework for reverse engineering executables, private
          software and games.
        </span>
        <br />
        <span>It stops a frontier model from refusing a task it can already do.</span>
      </p>
    </section>
  )
}
