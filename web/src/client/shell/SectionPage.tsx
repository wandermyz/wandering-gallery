import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { IconButton, Sheet } from '../common/ui';
import { SectionSwitcher } from './nav';

/**
 * Standard frame for a section: top bar with the drawer button and title, and a drawer
 * holding the section switcher (phones) above the section's own navigation.
 */
export function SectionPage({ title, sub, drawerTitle, nav, actions, children }: {
  title: string; sub?: string; drawerTitle: string;
  /** The drawer's own navigation; a function receives `close` for its links. */
  nav?: ComponentChildren | ((close: () => void) => ComponentChildren);
  actions?: ComponentChildren; children: ComponentChildren;
}) {
  const [menu, setMenu] = useState(false);
  return (
    <div class="app">
      <header class="topbar">
        <IconButton icon="menu" label={drawerTitle} onClick={() => setMenu(true)} />
        <div class="topbar-title">
          <h1>{title}</h1>
          {sub && <span class="topbar-sub">{sub}</span>}
        </div>
        {actions}
      </header>
      <main class="content">{children}</main>
      <Sheet open={menu} onClose={() => setMenu(false)} title={drawerTitle} class="sheet-left">
        <SectionSwitcher onPick={() => setMenu(false)} />
        {typeof nav === 'function' ? nav(() => setMenu(false)) : nav}
      </Sheet>
    </div>
  );
}
