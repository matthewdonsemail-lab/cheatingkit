export default function CallToAction({ videoUrl }) {
  return (
    <section className="help-cta" aria-labelledby="help-cta-heading">
      <span className="help-cta-dither" aria-hidden="true" />
      <div className="help-cta-content">
        <h2 id="help-cta-heading">Is your agent refusing to do a task you know it can do?</h2>
        <p>
          We might be able to help. Watch this short video to see if this will help your agent finish
          the current task.
        </p>
        {videoUrl && (
          <a className="help-cta-link" href={videoUrl}>
            Watch the short video <span aria-hidden="true">↗</span>
          </a>
        )}
      </div>
    </section>
  )
}
