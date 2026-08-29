import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { createPortal } from 'react-dom';

import { CaretDown, Check } from '@phosphor-icons/react';

/**
 * The dropdown (issue 171).
 *
 * There were eight native `<select>`s here and every one of them opened an
 * operating-system menu: a different typeface, none of the tokens, and a
 * different shape on each of the three platforms this runs on. The one moment
 * a control was actually being used was the one moment the product stopped
 * looking like itself.
 *
 * That is the cosmetic half. The half that matters is that a native `<option>`
 * holds one line, and every one of these controls sets what an unattended
 * agent will do overnight. So the sentence explaining the consequence -
 * "Manual holds the queue", "Unattended collects them for the morning" - was
 * parked in a `title` attribute on the closed control, reachable by resting a
 * pointer on it and waiting, and never on screen at the moment of choosing.
 *
 * Here the option carries its own consequence. The trigger shows the label
 * alone, because the board header is dense and has to stay dense; the list is
 * where the sentence goes. An option set with no hints renders as a plain
 * list, so this costs nothing where there is nothing to explain.
 */

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  /** What choosing this does. One line, in the interface's voice. */
  readonly hint?: string;
}

/** Where the list is, once it knows where the trigger is. */
interface Placement {
  readonly left: number;
  readonly width: number;
  /** Set when the list hangs below the trigger. */
  readonly top?: number;
  /** Set instead when it had to go above. */
  readonly bottom?: number;
}

/** Room to leave against the edge of the window, so the list never touches it. */
const MARGIN = 8;
/**
 * The list is at least this wide, however narrow the trigger is.
 *
 * Set by the consequences rather than by the labels: "Stops the queue after
 * every card." wraps to three lines at 200 and sits on one at 240, and a
 * one-line hint under a one-line label is the shape this list was drawn as.
 */
const MIN_WIDTH = 240;
/** And never taller than this, whatever the window allows. */
const MAX_HEIGHT = 320;

export function Select({
  value,
  options,
  onChange,
  label,
  title,
  placeholder = 'Choose',
  className = '',
  variant = 'field',
  onOpen,
}: {
  /** The chosen value, or null when nothing is chosen. */
  value: string | null;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  /** The accessible name. Every one of these is beside a visible label or is
   *  self-describing, so it is never rendered. */
  label: string;
  title?: string;
  /** Shown on the trigger when nothing is chosen. */
  placeholder?: string;
  className?: string;
  /**
   * Which box this sits in.
   *
   * `field` is the bordered well used everywhere a value is being set - the
   * card's settings, the timeline's filters - and is the same box as a text
   * field beside it. `bare` is for the board header, where four of these sit
   * inside one segmented control that already has the border and the rules
   * between them, and a border each would draw five boxes where there is one.
   */
  variant?: 'field' | 'bare';
  /** Called as the list opens. The card's "compare with" loads its options here
   *  rather than on mount, because most cards are never compared. */
  onOpen?: () => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<Placement | null>(null);
  /**
   * The row the keyboard is on, which is not the row that is chosen.
   *
   * Two different facts, and they are drawn differently: the chosen row keeps
   * a check and the brand's colour wherever it is in the list, and the active
   * row takes the well behind it. Drawn the same, arrowing past the chosen
   * value would look like changing it.
   */
  const [active, setActive] = useState(0);

  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  /** Letters typed in the last second, for jumping to an option by name. */
  const typed = useRef({ text: '', at: 0 });

  const id = useId();
  const listId = `${id}-list`;

  const chosen = options.find((option) => option.value === value) ?? null;
  const anyHints = options.some((option) => option.hint !== undefined);

  /**
   * Where to put the list.
   *
   * Measured rather than declared, because the list is portalled to the body:
   * rendered where it is used it would be clipped by the card flap, which
   * scrolls, and the card's model and priority sit inside that scroll.
   *
   * Below the trigger unless the room below is both too small and smaller than
   * the room above - a list that flips up the moment it is near the fold, when
   * it would have fitted, is a list that moves for no reason the operator can
   * see.
   */
  const position = useCallback(() => {
    const node = trigger.current;
    if (node === null) return;

    const box = node.getBoundingClientRect();
    const width = Math.min(
      Math.max(box.width, MIN_WIDTH),
      Math.max(window.innerWidth - 2 * MARGIN, MIN_WIDTH),
    );
    // Kept on screen when the trigger is close to the right edge, which the
    // board header's rightmost select always is.
    const left = Math.max(MARGIN, Math.min(box.left, window.innerWidth - width - MARGIN));

    const below = window.innerHeight - box.bottom - MARGIN;
    const above = box.top - MARGIN;
    const wanted = Math.min(MAX_HEIGHT, options.length * 46 + 8);

    setPlace(
      below >= wanted || below >= above
        ? { left, width, top: box.bottom + 4 }
        : { left, width, bottom: window.innerHeight - box.top + 4 },
    );
  }, [options.length]);

  useLayoutEffect(() => {
    if (open) position();
  }, [open, position]);

  /**
   * Follows the trigger rather than closing on it.
   *
   * The capture phase is the point: the flap scrolls in its own box, and a
   * listener on the window alone never hears about that. Closing instead would
   * be easier and worse - the operator scrolls a pane by habit while reading
   * the list they just opened.
   */
  useEffect(() => {
    if (!open) return;

    const onScrollOrResize = (): void => position();
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [open, position]);

  /** Anywhere but this control closes it, without acting on what was clicked. */
  useEffect(() => {
    if (!open) return;

    const onDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (trigger.current?.contains(target) === true) return;
      if (list.current?.contains(target) === true) return;
      setOpen(false);
    };

    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [open]);

  /**
   * Keeps the active row in view when the arrows walk past the edge of the box.
   *
   * By index rather than by id. The rows are this element's own children, and
   * `useId` returns `«r0»` - legal in an HTML id, not in a CSS selector, which
   * would put a `CSS.escape` in the middle of a keyboard handler.
   */
  useEffect(() => {
    if (!open) return;
    list.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const show = (): void => {
    if (open) return;
    onOpen?.();
    // Opens on the current value, so the first arrow key moves from where the
    // control actually is rather than from the top of the list.
    setActive(
      Math.max(
        0,
        options.findIndex((option) => option.value === value),
      ),
    );
    setOpen(true);
  };

  const close = (restore: boolean): void => {
    setOpen(false);
    if (restore) trigger.current?.focus();
  };

  const pick = (index: number): void => {
    const option = options[index];
    if (option === undefined) return;
    onChange(option.value);
    close(true);
  };

  /**
   * The keyboard, with focus never leaving the trigger.
   *
   * `aria-activedescendant` moves instead. Moving focus into a list that lives
   * in a portal at the end of the body means a screen reader's reading order
   * and the page's tab order stop agreeing with what is on screen.
   */
  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    const last = options.length - 1;

    if (!open) {
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
        event.preventDefault();
        show();
      }
      return;
    }

    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        close(true);
        return;
      case 'Tab':
        // Not swallowed: the focus is moving on, and a list left open behind it
        // would sit over the next control.
        setOpen(false);
        return;
      case 'Enter':
      case ' ':
        event.preventDefault();
        pick(active);
        return;
      case 'ArrowDown':
        event.preventDefault();
        setActive((current) => Math.min(last, current + 1));
        return;
      case 'ArrowUp':
        event.preventDefault();
        setActive((current) => Math.max(0, current - 1));
        return;
      case 'Home':
        event.preventDefault();
        setActive(0);
        return;
      case 'End':
        event.preventDefault();
        setActive(last);
        return;
      default:
        break;
    }

    // Typeahead. These lists carry model names and card titles, and finding
    // "sonnet" by arrowing is slower than typing it.
    if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return;
    const now = Date.now();
    const text =
      (now - typed.current.at < 1000 ? typed.current.text : '') + event.key.toLowerCase();
    typed.current = { text, at: now };

    const found = options.findIndex((option) => option.label.toLowerCase().startsWith(text));
    if (found !== -1) setActive(found);
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${id}-${String(active)}` : undefined}
        aria-haspopup="listbox"
        title={title}
        /* The same box as a text field on the card, because a column of
           settings is one set of controls and a dropdown two pixels of padding
           off from the field under it is the only difference the eye has to go
           on. `field` carries the padding, border, ground and size; the trigger
           adds only what a button needs. */
        className={`inline-flex items-center gap-2 text-left transition-colors ${
          variant === 'field'
            ? 'field hover:border-edge'
            : 'rounded-md px-2 py-1 text-dim hover:bg-well hover:text-ink'
        } ${className}`}
        onClick={() => (open ? close(false) : show())}
        onKeyDown={onKeyDown}
      >
        {/* Takes the room, so the caret is at the right edge of the control
            rather than wherever the value happens to end. `min-w-0` is what
            lets it truncate instead of pushing the caret out of the box. */}
        <span className="min-w-0 flex-1 truncate">
          {chosen === null ? <span className="text-faint">{placeholder}</span> : chosen.label}
        </span>
        {/* Dim, not faint. It is the one part of the control that says this can
            be opened at all, and at 12px in the lightest ink on the scale it
            read as a decoration on a disabled field. */}
        <CaretDown
          size={13}
          weight="bold"
          aria-hidden
          className={`-mr-0.5 shrink-0 text-dim transition-transform duration-150 motion-reduce:transition-none ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>

      {!open || place === null
        ? null
        : createPortal(
            <div
              ref={list}
              id={listId}
              role="listbox"
              aria-label={label}
              /* The scale is inherited from the surface the trigger is on, not
                 from the body this is portalled into. A menu opened from the
                 card reads at the card's size. */
              className={`fixed z-50 overflow-y-auto overscroll-contain rounded-lg border border-line bg-surface p-1 shadow-lg ${
                trigger.current?.closest('.flap') === null || trigger.current === null
                  ? ''
                  : 'type--reading'
              }`}
              style={{
                left: place.left,
                width: place.width,
                maxHeight: MAX_HEIGHT,
                ...(place.top === undefined ? { bottom: place.bottom } : { top: place.top }),
              }}
            >
              {options.map((option, index) => {
                const isChosen = option.value === value;
                return (
                  <div
                    key={option.value}
                    id={`${id}-${String(index)}`}
                    role="option"
                    aria-selected={isChosen}
                    className={`flex cursor-pointer items-start gap-2 rounded-md px-2.5 py-1.5 ${
                      index === active ? 'bg-well' : ''
                    }`}
                    onPointerEnter={() => setActive(index)}
                    onClick={() => pick(index)}
                  >
                    <div className="min-w-0 flex-1">
                      <div className={isChosen ? 'font-medium text-brand' : 'text-ink'}>
                        {option.label}
                      </div>
                      {option.hint === undefined ? null : (
                        <div className="t-fine leading-snug text-faint">{option.hint}</div>
                      )}
                    </div>
                    {/* The check, and nothing else, says which one is set. The
                        well behind a row says where the keyboard is. Two facts,
                        two marks - drawn the same, arrowing past the chosen
                        value would read as changing it. */}
                    <Check
                      size={13}
                      weight="bold"
                      aria-hidden
                      className={`mt-1 shrink-0 text-brand ${isChosen ? '' : 'invisible'} ${
                        anyHints ? '' : 'mt-0.5'
                      }`}
                    />
                  </div>
                );
              })}
            </div>,
            document.body,
          )}
    </>
  );
}
