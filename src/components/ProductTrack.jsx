import { products } from '../data/products.js'

function CardMedia({ id, name, badgeText }) {
  return (
    <a
      href="/README.md"
      data-slot="media"
      data-product={id}
      aria-label={name}
      data-hero-light=""
      data-hero-dark=""
      className="relative block aspect-[4/5] overflow-hidden bg-[#1a1a1a]"
    >
      {badgeText && (
        <span
          data-slot="badge"
          className="absolute left-2 top-2 z-10 bg-[#54d483] px-1 py-0.5 font-mono text-[0.65rem] text-[#0c0c0c]"
        >
          {badgeText}
        </span>
      )}
      <video
        aria-hidden="true"
        data-set=""
        data-demo=""
        muted
        loop
        playsInline
        preload="auto"
        className="block h-full w-full object-cover"
      >
        <source src="" type="video/mp4" />
      </video>
      <picture data-still="" className="block h-full w-full object-cover">
        <source type="image/avif" srcSet="" sizes="(max-width: 40rem) 90vw, 342px" />
        <img
          data-slot="still"
          data-poster="true"
          src=""
          sizes="(max-width: 40rem) 90vw, 342px"
          width="1064"
          height="1330"
          alt=""
          aria-hidden="true"
          data-set=""
          data-mode="demo"
          className="block h-full w-full object-cover"
        />
      </picture>
      <video
        data-slot="still"
        data-set=""
        data-mode="demo"
        aria-hidden="true"
        muted
        loop
        playsInline
        preload="none"
        className="block h-full w-full object-cover"
      >
        <source src="" type="video/mp4" />
      </video>
    </a>
  )
}

export default function ProductTrack() {
  return (
    <section
      data-component="products"
      data-section="products"
      aria-label="What CheatingKit takes apart"
      className="mx-0 box-border w-full max-w-none overflow-hidden border-t-0 px-0 pb-10 pt-6 [border-image:none]"
    >
      <div
        data-slot="track"
        id="products-track"
        className="flex flex-nowrap gap-5 overflow-x-auto border-0 bg-none px-0 [overscroll-behavior-inline:contain] [scroll-snap-type:x_mandatory] [scrollbar-width:none]"
      >
        {products.map((product) => (
          <article
            data-component="product-card"
            key={product.id}
            className="flex min-w-0 flex-[1_0_14rem] flex-col gap-3 border-0 bg-none px-1 py-0 [scroll-snap-align:start]"
          >
            <CardMedia id={product.id} name={product.name} badgeText={product.badge} />
            <h3 className="font-mono text-[17px] font-bold">
              <a href="/README.md" className="font-mono text-[17px] font-bold text-[#fafafa]">
                {product.name}
              </a>
            </h3>
            <p className="font-sans text-[15px] leading-normal text-[#aeaeae]">
              {product.description}
            </p>
            <a href="/README.md" data-component="site-button" className="mt-auto self-start font-mono">
              Read more
            </a>
          </article>
        ))}
      </div>
    </section>
  )
}
