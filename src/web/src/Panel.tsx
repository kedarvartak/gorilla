import { useEffect, useRef, type ReactElement, type ReactNode } from 'react';

/**
 * The frame every overlay panel shares (T79).
 *
 * Five of these accumulated over a day - the digest, the activity feed, the
 * project rules, the order, the numbers - and each one was a bare div. To
 * anything that is not a pair of eyes they were part of the board underneath:
 * unnamed, unannounced, and impossible to leave without finding the close
 * button with a mouse.
 *
 * Shared rather than copied five times, because the sixth panel is the one
 * that would have been written without any of this.
 */

export function Panel({
  title,
  children,
  onClose,
}: {
  /** Named for a screen reader, which cannot see the heading beside it. */
  title: string;
  children: ReactNode;
  onClose: () => void;
}): ReactElement {
  const frame = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Focus moves in on open. Without it the keyboard stays on the board
    // behind, where the next key press does something invisible.
    frame.current?.focus();

    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={frame}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
      className="absolute inset-0 z-10 flex flex-col bg-canvas focus:outline-none"
    >
      {children}
    </div>
  );
}
