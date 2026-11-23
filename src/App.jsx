import Topbar from './components/Topbar.jsx'
import CallToAction from './components/CallToAction.jsx'
import Hero from './components/Hero.jsx'
import ProductTrack from './components/ProductTrack.jsx'
import MoreTools from './components/MoreTools.jsx'
import Faq from './components/Faq.jsx'
import Footer from './components/Footer.jsx'
import LeftRail from './components/LeftRail.jsx'
import DocsPage from './components/docs/DocsPage.jsx'

export default function App() {
  if (window.location.pathname === '/docs' || window.location.pathname.startsWith('/docs/')) {
    return <DocsPage />
  }

  return (
    <div
      data-site=""
      data-page="home"
      data-theme="dark"
      data-spacer="line"
      data-logo="icon"
      data-hero-install="off"
      data-home-announcement="off"
      data-banner-host=""
      data-dark-blue="6b8fff"
      data-logo-size="20×25"
      data-menu-active="bar"
      data-menu-color="grey"
      data-button-hover="blue"
      data-menu-align="edge"
      data-nav-numbers="1"
      data-status-bars="4"
      data-logo-menu-hover="blue"
      data-sidebar="column"
      className="font-normal [--selection-alpha:10%] [--hero-scale:1] [--page-offset:0px] [--page-offset-end:0px] [--rail-w:clamp(3.5rem,13vw,14rem)] [--page-pad:clamp(0.75rem,1.4vw,1.25rem)] [padding-inline:0]"
    >
      <Topbar />
      <main
        data-component="content"
        id="content"
        tabIndex={-1}
        className="ml-[var(--rail-w)] box-border min-w-0 px-[var(--page-pad)] [--visible:4] [--gaps:3] [--body-cards:99]"
      >
        <div data-slot="page">
          <Hero />
          <ProductTrack />
          <CallToAction />
          <hr className="my-0 block h-px w-full border-0 bg-[#242424]" />
          <MoreTools />
          <hr className="my-0 block h-px w-full border-0 bg-[#242424]" />
          <Faq />
          <Footer />
        </div>
      </main>
      <LeftRail />
    </div>
  )
}
