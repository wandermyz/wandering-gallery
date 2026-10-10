import { useEffect, useState } from 'preact/hooks';
import { DEFAULT_SECTION, SECTIONS, type SectionId } from './sections';

// The shell only picks the section from the first path segment. Everything below it
// (sub-paths and the query string) belongs to the section, which manages its own history.

const NAV_EVENT = 'wg:section';

export function sectionOf(pathname: string): SectionId | null {
  const first = pathname.split('/')[1] ?? '';
  return SECTIONS.find((s) => s.path === `/${first}`)?.id ?? null;
}

/**
 * Maps pre-section URLs onto the gallery: `/?…` → `/gallery?…`, `/trash` → `/gallery/trash`.
 * Bookmarks, the home-screen app (start_url "/") and links to an open asset keep working.
 * Unknown paths land on the default section.
 */
export function rewriteLegacyUrl() {
  const { pathname, search, hash } = location;
  if (sectionOf(pathname)) return;
  const target = pathname === '/trash' || pathname === '/trash/' ? '/gallery/trash'
    : pathname === '/' ? '/gallery'
    : SECTIONS.find((s) => s.id === DEFAULT_SECTION)!.path;
  history.replaceState(history.state, '', target + search + hash);
}

export function currentSection(): SectionId {
  return sectionOf(location.pathname) ?? DEFAULT_SECTION;
}

export function useSection(): SectionId {
  const [section, setSection] = useState(currentSection);
  useEffect(() => {
    const on = () => setSection(currentSection());
    window.addEventListener('popstate', on);
    window.addEventListener(NAV_EVENT, on);
    return () => {
      window.removeEventListener('popstate', on);
      window.removeEventListener(NAV_EVENT, on);
    };
  }, []);
  return section;
}

// Where each section was last left, so switching back restores its view (filters, folder…).
const lastUrl = new Map<SectionId, string>();

export function goSection(id: SectionId) {
  const cur = currentSection();
  if (id === cur) return;
  lastUrl.set(cur, location.pathname + location.search);
  history.pushState(null, '', lastUrl.get(id) ?? SECTIONS.find((s) => s.id === id)!.path);
  window.scrollTo(0, 0);
  window.dispatchEvent(new Event(NAV_EVENT));
}
