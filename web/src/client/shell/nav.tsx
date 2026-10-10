import { Icon } from '../common/ui';
import { cx } from '../common/util';
import { goSection, useSection } from './router';
import { SECTIONS } from './sections';

function onLink(e: MouseEvent, run: () => void) {
  // Let modified clicks open a new tab as usual.
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
  e.preventDefault();
  run();
}

/** Desktop: a fixed rail of sections on the left edge. Hidden on narrow screens by CSS. */
export function NavRail() {
  const active = useSection();
  return (
    <nav class="rail" aria-label="Sections">
      {SECTIONS.map((s) => (
        <a key={s.id} href={s.path} class={cx('rail-item', s.id === active && 'active')} aria-current={s.id === active ? 'page' : undefined}
          onClick={(e) => onLink(e, () => goSection(s.id))}>
          <Icon name={s.icon} size={22} />
          <span>{s.label}</span>
        </a>
      ))}
    </nav>
  );
}

/** Phones: the section switcher at the top of each section's drawer. Hidden where the rail shows. */
export function SectionSwitcher({ onPick }: { onPick?: () => void }) {
  const active = useSection();
  return (
    <nav class="section-switch" aria-label="Sections">
      {SECTIONS.map((s) => (
        <a key={s.id} href={s.path} class={cx(s.id === active && 'on')} aria-current={s.id === active ? 'page' : undefined}
          onClick={(e) => onLink(e, () => {
            onPick?.();
            goSection(s.id);
          })}>
          <Icon name={s.icon} size={20} />
          <span>{s.label}</span>
        </a>
      ))}
    </nav>
  );
}
