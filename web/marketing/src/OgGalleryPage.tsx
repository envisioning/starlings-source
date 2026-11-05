import { AppShell } from './SiteChrome';
import { HERO, PAGE } from './bento';

/**
 * /brand/og: every page's share card on one page, grouped by the family its
 * footer names, like www's /about/brand/og lab. The prerender passes the
 * list (marketing/prerender.mjs) and writes the page as static HTML. It has
 * no client route and is left out of the sitemap and llms.txt, so it is a
 * page for us, not for search.
 */
export type OgGalleryCard = { path: string; title: string; image: string; family: string };

export function OgGalleryPage({ cards }: { cards: readonly OgGalleryCard[] }) {
  const families = [...new Set(cards.map((card) => card.family))];
  return (
    <AppShell variant="wide">
      <div className={PAGE}>
        <header className={HERO}>
          <h1>Share cards.</h1>
          <p className="lede">The card each page shows when someone shares its link: {cards.length} cards. Each opens its page; the address under it is the image.</p>
        </header>
        {families.map((family) => (
          <section key={family} className="mb-12">
            <h2 className="mb-4">{family}</h2>
            <ul className="m-0 grid list-none grid-cols-3 gap-4 p-0 max-[960px]:grid-cols-2 max-[640px]:grid-cols-1">
              {cards.filter((card) => card.family === family).map((card) => (
                <li key={card.path} className="flex min-w-0 flex-col gap-1.5">
                  <a href={card.path} className="block overflow-hidden rounded-md border border-border hover-lift">
                    <img src={card.image} alt={card.title} width={1200} height={630} loading="lazy" className="block h-auto w-full" />
                  </a>
                  <a href={card.image} className="truncate text-[12px] text-muted-foreground">{card.image}</a>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </AppShell>
  );
}
