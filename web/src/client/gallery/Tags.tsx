import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, thumbUrl, type Asset, type Tag } from './api';
import { Icon, Spinner, type ConfirmOptions, type ToastMsg } from '../common/ui';
import { cx } from '../common/util';

// All tags, shared by every editor so suggestions show up without a round trip.
let tagCache: Tag[] | null = null;
const TAGS_EVENT = 'wg:tags';

export function loadTags(): Promise<Tag[]> {
  return api.tags().then((r) => {
    tagCache = r.tags;
    window.dispatchEvent(new CustomEvent(TAGS_EVENT));
    return r.tags;
  });
}

function useAllTags(): Tag[] | null {
  const [tags, setTags] = useState(tagCache);
  useEffect(() => {
    const on = () => setTags(tagCache);
    window.addEventListener(TAGS_EVENT, on);
    void loadTags().catch(() => {});
    return () => window.removeEventListener(TAGS_EVENT, on);
  }, []);
  return tags;
}

const norm = (s: string) => s.trim().replace(/\s+/g, ' ');
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Tags of one asset: chips to remove or open, and an input that suggests existing
 * tags as you type and offers to create a new one.
 */
export function TagEditor({ asset: a, onChange, onOpenTag, focusKey }: {
  asset: Asset;
  onChange: (a: Asset) => void;
  onOpenTag?: (name: string) => void;
  /** Focuses the input whenever this changes (e.g. the T shortcut). */
  focusKey?: number;
}) {
  const all = useAllTags();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setText('');
    setError(null);
  }, [a.id]);
  useEffect(() => {
    if (focusKey) input.current?.focus();
  }, [focusKey]);

  const q = norm(text);
  const options = useMemo(() => {
    const have = (n: string) => a.tags.some((t) => same(t, n));
    const lq = q.toLowerCase();
    const matches = (all ?? [])
      .filter((t) => !have(t.name) && (!lq || t.name.toLowerCase().includes(lq)))
      // Prefix matches first, then the most used.
      .sort((x, y) => Number(y.name.toLowerCase().startsWith(lq)) - Number(x.name.toLowerCase().startsWith(lq)) || y.count - x.count)
      .slice(0, 8)
      .map((t) => ({ name: t.name, count: t.count, create: false }));
    const exists = (all ?? []).some((t) => same(t.name, q)) || have(q);
    if (q && !exists) matches.push({ name: q, count: 0, create: true });
    return matches;
  }, [all, q, a.tags]);
  useEffect(() => setActive(0), [q]);

  const change = async (c: { add?: string[]; remove?: string[] }) => {
    setBusy(true);
    setError(null);
    try {
      onChange(await api.setTags(a.id, c));
      void loadTags().catch(() => {});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const add = async (name: string) => {
    if (!norm(name) || a.tags.some((t) => same(t, name))) {
      setText('');
      return;
    }
    setText('');
    await change({ add: [name] });
    input.current?.focus();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
      if (options.length) setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const o = open ? options[active] : undefined;
      void add(o ? o.name : q);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      if (open && (text || options.length)) {
        e.preventDefault();
        setOpen(false);
      } else input.current?.blur();
    } else if (e.key === 'Backspace' && !text && a.tags.length) {
      void change({ remove: [a.tags[a.tags.length - 1]] });
    }
  };

  return (
    <div class="tag-editor">
      {a.tags.length > 0 && (
        <ul class="tag-chips">
          {a.tags.map((t) => (
            <li key={t} class="tag-chip">
              <button type="button" class="tag-chip-name" title={`Show all tagged "${t}"`} onClick={() => onOpenTag?.(t)}>{t}</button>
              <button type="button" class="tag-chip-x" aria-label={`Remove tag ${t}`} disabled={busy} onClick={() => void change({ remove: [t] })}>
                <Icon name="close" size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div class="tag-combo">
        <input
          ref={input}
          class="tag-input"
          type="text"
          placeholder={a.tags.length ? 'Add another tag…' : 'Add a tag…'}
          value={text}
          maxLength={64}
          enterKeyHint="done"
          autoComplete="off"
          autoCapitalize="off"
          spellcheck={false}
          role="combobox"
          aria-expanded={open && options.length > 0}
          aria-label="Add a tag"
          onInput={(e) => {
            setText((e.target as HTMLInputElement).value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          // Let a tap on a suggestion land before the list closes.
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={onKey}
        />
        {busy && <span class="tag-busy"><Spinner /></span>}
        {open && options.length > 0 && (
          <ul class="tag-options" role="listbox">
            {options.map((o, i) => (
              <li key={o.name + o.create} role="option" aria-selected={i === active}>
                <button
                  type="button"
                  class={cx('tag-option', i === active && 'active', o.create && 'create')}
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => void add(o.name)}
                >
                  {o.create ? <><Icon name="plus" size={14} /> Create “{o.name}”</> : <>
                    <span class="tag-option-name">{o.name}</span>
                    <span class="tag-option-count">{o.count}</span>
                  </>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && <p class="error-text tag-error">{error}</p>}
    </div>
  );
}

/** All tags with a cover and a count; opens one, or renames / deletes it. */
export function TagsView({ onOpen, toast, ask, hiding, unlocked, onUnlock }: {
  onOpen: (name: string) => void;
  /** Hiding is set up (a passphrase is configured). */
  hiding: boolean;
  unlocked: boolean;
  onUnlock: () => void;
  toast: (t: string, o?: Partial<ToastMsg>) => void;
  ask: (o: ConfirmOptions) => Promise<boolean>;
}) {
  const all = useAllTags();
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState<{ id: number; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadTags().catch((e) => setError((e as Error).message));
  }, []);

  const rename = async () => {
    if (!editing) return;
    const tag = all?.find((t) => t.id === editing.id);
    const name = norm(editing.name);
    setEditing(null);
    if (!tag || !name || name === tag.name) return;
    const target = all?.find((t) => t.id !== tag.id && same(t.name, name));
    if (target && !(await ask({
      title: 'Merge tags?',
      message: <p>There is already a tag “{target.name}”. Everything tagged “{tag.name}” will get “{name}” instead.</p>,
      confirm: 'Merge',
    }))) return;
    try {
      const r = await api.renameTag(tag.id, name);
      toast(r.merged ? `Merged into “${r.name}”` : `Renamed to “${r.name}”`);
    } catch (e) {
      toast((e as Error).message, { kind: 'error' });
    }
    void loadTags().catch(() => {});
  };

  const toggleHidden = async (t: Tag) => {
    if (t.hidden && !unlocked) return onUnlock();
    try {
      await api.hideTag(t.id, !t.hidden);
      toast(t.hidden ? `“${t.name}” is no longer hidden` : `Hid “${t.name}”`);
    } catch (e) {
      toast((e as Error).message, { kind: 'error' });
    }
    void loadTags().catch(() => {});
  };

  const remove = async (t: Tag) => {
    const ok = await ask({
      title: `Delete tag “${t.name}”?`,
      message: <p class="muted">The tag is removed from {t.count === 1 ? '1 item' : `${t.count} items`}. The files are not touched.</p>,
      confirm: 'Delete tag',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteTag(t.id);
      toast(`Deleted “${t.name}”`);
    } catch (e) {
      toast((e as Error).message, { kind: 'error' });
    }
    void loadTags().catch(() => {});
  };

  if (error && !all) return <div class="banner banner-error"><Icon name="alert" size={18} /> {error}</div>;
  if (!all) return <Spinner label="Loading tags" />;
  const lf = norm(filter).toLowerCase();
  const shown = all.filter((t) => !lf || t.name.toLowerCase().includes(lf));
  return (
    <div class="tags-view">
      {all.length === 0 ? (
        <div class="empty">
          <Icon name="tag" size={40} />
          <p>No tags yet.</p>
          <p class="muted small">Open an image, tap ⓘ, and add tags in the Tags section (or press T).</p>
        </div>
      ) : (
        <>
          {all.length > 8 && (
            <input class="tag-input tags-filter" type="search" placeholder="Filter tags" value={filter}
              onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
          )}
          <ul class="tags-list">
            {shown.map((t) => (
              <li key={t.id} class="tags-item">
                {editing?.id === t.id ? (
                  <form class="tags-rename" onSubmit={(e) => { e.preventDefault(); void rename(); }}>
                    <input
                      class="tag-input"
                      value={editing.name}
                      maxLength={64}
                      autoFocus
                      aria-label="New tag name"
                      onInput={(e) => setEditing({ id: t.id, name: (e.target as HTMLInputElement).value })}
                      onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setEditing(null))}
                    />
                    <button type="submit" class="btn btn-sm btn-primary">Save</button>
                    <button type="button" class="btn btn-sm" onClick={() => setEditing(null)}>Cancel</button>
                  </form>
                ) : (
                  <>
                    <button type="button" class="tags-open" onClick={() => onOpen(t.name)}>
                      {t.cover ? <img src={thumbUrl(t.cover)} alt="" loading="lazy" /> : <span class="folder-ph"><Icon name="tag" size={20} /></span>}
                      <span class="tags-name">
                        {t.name}
                        {t.hidden && <span class="lib-ro" title="Hidden tag"><Icon name="eye-off" size={12} /></span>}
                      </span>
                      <span class="lib-count">{t.count}</span>
                    </button>
                    <button type="button" class="chip-btn" onClick={() => setEditing({ id: t.id, name: t.name })}>Rename</button>
                    {hiding && (
                      <button type="button" class="chip-btn" aria-label={`${t.hidden ? 'Unhide' : 'Hide'} tag ${t.name}`}
                        title={t.hidden ? 'Unhide' : 'Hide'} onClick={() => void toggleHidden(t)}>
                        <Icon name={t.hidden ? 'eye' : 'eye-off'} size={15} />
                      </button>
                    )}
                    <button type="button" class="chip-btn btn-danger-ghost" aria-label={`Delete tag ${t.name}`} onClick={() => void remove(t)}>
                      <Icon name="trash" size={15} />
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
          {shown.length === 0 && <p class="muted pad">No tag matches “{filter}”.</p>}
        </>
      )}
    </div>
  );
}
