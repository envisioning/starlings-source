import { lazy, Suspense, useEffect, useState } from 'react';
import { OPEN_EVENT, type SearchPaletteRequest } from './search-doors';

const SearchPalette = lazy(async () => ({ default: (await import('./SearchPalette')).SearchPalette }));

/**
 * ⌘K anywhere, and the header icon (`openSearchPalette`). The palette is
 * cmdk in a Radix dialog, so it loads the first time it opens and stays
 * mounted after that; this listener is all a page carries until then.
 */
export function SearchPaletteHost() {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  /** What the last opener asked for; a new object each time, so the same words twice still land. */
  const [request, setRequest] = useState<SearchPaletteRequest>({});

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const command = (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey;
      if (command && (event.key === 'k' || event.key === 'K')) {
        event.preventDefault();
        setLoaded(true);
        setRequest({});
        setOpen((current) => !current);
      }
    };
    const onOpen = (event: Event) => {
      setLoaded(true);
      setRequest(event instanceof CustomEvent && event.detail ? { ...(event.detail as SearchPaletteRequest) } : {});
      setOpen(true);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);

  if (!loaded) return null;
  return (
    <Suspense fallback={null}>
      <SearchPalette open={open} onOpenChange={setOpen} request={request} />
    </Suspense>
  );
}
