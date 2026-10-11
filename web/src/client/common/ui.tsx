import type { ButtonHTMLAttributes, ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { copyText, cx } from './util';

const PATHS: Record<string, string> = {
  heart: 'M12 21s-7.5-4.6-9.6-9.3C.9 8.2 3.1 4.5 6.8 4.5c2.1 0 3.6 1.1 5.2 3 1.6-1.9 3.1-3 5.2-3 3.7 0 5.9 3.7 4.4 7.2C19.5 16.4 12 21 12 21z',
  star: 'M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4L2.8 9.5l6.4-.8z',
  close: 'M6 6l12 12M18 6L6 18',
  back: 'M15 5l-7 7 7 7',
  next: 'M9 5l7 7-7 7',
  menu: 'M4 7h16M4 12h16M4 17h16',
  info: 'M12 8h.01M11 12h1v5h1M12 3a9 9 0 100 18 9 9 0 000-18z',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  restore: 'M4 12a8 8 0 108-8 8.2 8.2 0 00-6 2.7L4 9M4 4v5h5',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  share: 'M12 15V3M8 7l4-4 4 4M6 11H5v10h14V11h-1',
  filter: 'M4 6h16M7 12h10M10 18h4',
  folder: 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z',
  play: 'M8 5.5v13l11-6.5z',
  refresh: 'M20 12a8 8 0 11-2.3-5.7M20 4v5h-5',
  copy: 'M9 9h10v11H9zM5 15V4h10',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  check: 'M5 12l5 5 9-10',
  alert: 'M12 9v4M12 17h.01M10.3 3.9L2 18a2 2 0 001.7 3h16.6a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z',
  lock: 'M7 11V8a5 5 0 0110 0v3M5 11h14v10H5z',
  sort: 'M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15.5 9.5h.01',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM18.5 15l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z',
  tag: 'M3 12.2V4a1 1 0 011-1h8.2a1 1 0 01.7.3l8.4 8.4a1 1 0 010 1.4l-8.2 8.2a1 1 0 01-1.4 0l-8.4-8.4a1 1 0 01-.3-.7zM7.5 7.5h.01',
  flask: 'M9 3h6M10 3v6l-5.4 9.2A1.9 1.9 0 006.2 21h11.6a1.9 1.9 0 001.6-2.8L14 9V3M7.2 15h9.6',
};

const FILLED = new Set(['heart', 'star', 'play']);

export function Icon({ name, filled, size = 22, class: className }: { name: keyof typeof PATHS | string; filled?: boolean; size?: number; class?: string }) {
  const fill = filled ?? FILLED.has(name);
  return (
    <svg
      class={cx('icon', className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill ? 'currentColor' : 'none'}
      stroke="currentColor"
      stroke-width={fill ? 0 : 1.8}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

export function IconButton(props: ButtonHTMLAttributes<HTMLButtonElement> & { icon: string; label: string; active?: boolean; filled?: boolean; size?: number }) {
  const { icon, label, active, filled, size, class: className, ...rest } = props;
  return (
    <button type="button" class={cx('icon-btn', active && 'active', className as string)} aria-label={label} title={label} {...rest}>
      <Icon name={icon} filled={filled} size={size} />
    </button>
  );
}

/** Interactive 0-5 rating. Tapping the current rating clears it. */
export function Stars({ value, onChange, size = 24 }: { value: number; onChange?: (v: number) => void; size?: number }) {
  return (
    <div class="stars" role={onChange ? 'radiogroup' : undefined} aria-label={`Rating: ${value} of 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          type="button"
          key={n}
          class={cx('star', n <= value && 'on')}
          disabled={!onChange}
          role={onChange ? 'radio' : undefined}
          aria-checked={n === value}
          aria-label={`${n} star${n > 1 ? 's' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            onChange?.(n === value ? 0 : n);
          }}
        >
          <Icon name="star" size={size} />
        </button>
      ))}
    </div>
  );
}

/** Small read-only badge for grid cells. */
export function MiniRating({ value }: { value: number }) {
  if (!value) return null;
  return (
    <span class="mini-rating" aria-label={`${value} stars`}>
      <Icon name="star" size={11} />
      {value}
    </span>
  );
}

export function Sheet({ open, onClose, title, children, class: className }: {
  open: boolean; onClose: () => void; title?: string; children: ComponentChildren; class?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div class="sheet-backdrop" onClick={onClose}>
      <div class={cx('sheet', className)} role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div class="sheet-grip" />
        {title && (
          <div class="sheet-head">
            <h2>{title}</h2>
            <IconButton icon="close" label="Close" onClick={onClose} />
          </div>
        )}
        <div class="sheet-body">{children}</div>
      </div>
    </div>
  );
}

export interface ConfirmOptions {
  title: string;
  message: ComponentChildren;
  confirm: string;
  danger?: boolean;
}

export function ConfirmDialog({ opts, onResult }: { opts: ConfirmOptions | null; onResult: (ok: boolean) => void }) {
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!opts) return;
    btn.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        onResult(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [opts]);
  if (!opts) return null;
  return (
    <div class="dialog-backdrop" onClick={() => onResult(false)}>
      <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dlg-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="dlg-title">{opts.title}</h2>
        <div class="dialog-msg">{opts.message}</div>
        <div class="dialog-actions">
          <button type="button" class="btn" onClick={() => onResult(false)}>Cancel</button>
          <button type="button" ref={btn} class={cx('btn', opts.danger ? 'btn-danger' : 'btn-primary')} onClick={() => onResult(true)}>
            {opts.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}

export interface ToastMsg {
  id: number;
  text: string;
  kind?: 'error' | 'info';
  action?: { label: string; run: () => void };
}

export function Toasts({ toasts, dismiss }: { toasts: ToastMsg[]; dismiss: (id: number) => void }) {
  return (
    <div class="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} class={cx('toast', t.kind === 'error' && 'toast-error')}>
          <span>{t.text}</span>
          {t.action && (
            <button
              type="button"
              class="toast-action"
              onClick={() => {
                t.action!.run();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div class="spinner-wrap" role="status">
      <div class="spinner" />
      {label && <span>{label}</span>}
    </div>
  );
}

/** Copy button that briefly shows a check mark. */
export function CopyButton({ text, label = 'Copy' }: { text: string | (() => Promise<string>); label?: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  return (
    <button
      type="button"
      class={cx('chip-btn', state === 'ok' && 'ok')}
      onClick={async (e) => {
        e.stopPropagation();
        const value = typeof text === 'string' ? text : await text();
        setState((await copyText(value)) ? 'ok' : 'fail');
        setTimeout(() => setState('idle'), 1400);
      }}
    >
      <Icon name={state === 'ok' ? 'check' : 'copy'} size={15} />
      {state === 'ok' ? 'Copied' : state === 'fail' ? 'Failed' : label}
    </button>
  );
}
