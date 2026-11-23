const features = [
  {
    title: 'Reverse engineer executables',
    body: 'Point it at an executable and get the pieces, what each one does, and how it fits together.',
  },
  {
    title: 'Break down private software',
    body: 'Take closed software apart without the refusal getting in the way.',
  },
  { title: 'Take games apart', body: 'See how a game is built, piece by piece.' },
  {
    title: 'From browsers to binaries',
    body: "We did this with social media clients and the browser. Now it's executables and DLLs.",
  },
  {
    title: 'Context-aware, on your machine',
    body: 'Small local CPU models steer the model into the right context before it answers.',
  },
  { title: 'Say it plainly', body: 'Hard ideas get short sentences. No jargon wall.' },
]

export default function WhatItIs() {
  return (
    <section data-component="block" data-section="what" data-columns="2">
      <h2 data-slot="label">What it is</h2>
      <div data-slot="body">
        <p data-slot="lead">
          cheatingkit is an open-source framework built on top of Morluto's Reverse Engineer
          Anything. It is designed to defeat the refusals frontier models throw up when you try to
          reverse engineer something. We built it while building an open-source go-to-market agency,
          where our agents kept hitting the same wall: the model could do the task, then refused to
          do it.
        </p>
        <ul id="home-features" data-component="features">
          {features.map((feature) => (
            <li key={feature.title}>
              <a href="#what">
                <strong>
                  <span>{feature.title}</span>
                </strong>
                <span>{feature.body}</span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
