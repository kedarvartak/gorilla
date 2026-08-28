import type { ReactElement } from 'react';

import { LOGO_PATH, LOGO_VIEWBOX } from './logo.js';

/**
 * The mark, at whatever size and colour it is asked for.
 *
 * `currentColor` rather than a fixed brand value: the rail draws it in the
 * brand colour, but it has to survive a dark surface and a disabled state
 * without a second copy of the geometry existing to do it.
 */
export function Logo({ size = 24, title }: { size?: number; title?: string }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox={LOGO_VIEWBOX}
      fill="currentColor"
      // Decorative by default: the rail puts the product's name beside it, and
      // a mark announced twice is noise. A title makes it an image with a name.
      role={title === undefined ? 'presentation' : 'img'}
      aria-hidden={title === undefined}
      focusable="false"
    >
      {title === undefined ? null : <title>{title}</title>}
      <path fillRule="evenodd" d={LOGO_PATH} />
    </svg>
  );
}
