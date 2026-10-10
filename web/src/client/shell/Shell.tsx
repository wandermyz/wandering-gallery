import type { ComponentType } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Spinner } from '../common/ui';
import GalleryApp from '../gallery/GalleryApp';
import { NavRail } from './nav';
import { useSection } from './router';
import type { SectionId } from './sections';

// The gallery is the landing page and ships in the main bundle; the other sections are
// loaded on first use so they never weigh on it.
const LAZY: Record<Exclude<SectionId, 'gallery'>, () => Promise<{ default: ComponentType }>> = {
  generate: () => import('../generate/GenerateApp'),
  train: () => import('../train/TrainApp'),
};

function LazySection({ id }: { id: keyof typeof LAZY }) {
  const [Comp, setComp] = useState<ComponentType | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setComp(null);
    setError(null);
    LAZY[id]().then((m) => alive && setComp(() => m.default), (e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [id]);
  if (error) return <div class="banner banner-error">Could not load this page: {error}</div>;
  return Comp ? <Comp /> : <Spinner />;
}

export function Shell() {
  const section = useSection();
  return (
    <>
      <NavRail />
      {section === 'gallery' ? <GalleryApp /> : <LazySection key={section} id={section} />}
    </>
  );
}
