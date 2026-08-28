/**
 * The mark.
 *
 * A card with two lines written on it: one long, one short. That pairing is the
 * grammar of text rather than of decoration - two lines of equal length read as
 * an equals sign, and one line alone reads as a prohibition - and a card
 * carrying a written account is the object this product exists to produce. The
 * board watches sessions; what it hands back is the brief.
 *
 * Drawn rather than chosen from an icon set, and deliberately not a gorilla:
 * an animal at sixteen pixels is a smudge, and the rail and the browser tab are
 * both sixteen-pixel problems.
 *
 * Geometry is symmetric on both axes - six pixels of margin at each side, and
 * 5.75 above the first line and below the second - because at this size an
 * optical correction is indistinguishable from a mistake. The counters are cut
 * with `evenodd` rather than painted over in the background colour, so the mark
 * works on the rail, on a dark tab strip, and on anything else.
 */

/** The square the path is drawn in. Kept here so nothing has to guess it. */
export const LOGO_VIEWBOX = '0 0 32 32';

/**
 * The whole mark as one path: the rounded square, then the two counters.
 *
 * One string, exported once, because it is drawn in two places that cannot
 * import from each other - this module for the interface, and a data URI in
 * `index.html` for the tab. A test asserts they still match.
 */
export const LOGO_PATH =
  // The card.
  'M 3,11 A 8,8 0 0 1 11,3 H 21 A 8,8 0 0 1 29,11 V 21 A 8,8 0 0 1 21,29 H 11 A 8,8 0 0 1 3,21 Z ' +
  // The first line, full width.
  'M 11.5,8.75 H 20.5 A 2.5,2.5 0 0 1 20.5,13.75 H 11.5 A 2.5,2.5 0 0 1 11.5,8.75 Z ' +
  // The second, stopping short of it, which is what makes the pair read as
  // writing rather than as a symbol.
  'M 11.5,18.25 H 14.5 A 2.5,2.5 0 0 1 14.5,23.25 H 11.5 A 2.5,2.5 0 0 1 11.5,18.25 Z';
