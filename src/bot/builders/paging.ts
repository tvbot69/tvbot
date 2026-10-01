/**
 * The page size these paginated cards actually slice with.
 *
 * `pageSize` arrives as an optional caller-supplied number, so `0` is
 * type-legal. It is also fatal: `Math.ceil(n / 0)` is `Infinity`, the clamp
 * below leaves the index alone, `Array.prototype.slice(0, 0)` is empty, and the
 * joined body handed to `TextDisplayBuilder.setContent` is `''` — which
 * discord.js rejects. The card is not wrong, it is unsendable.
 *
 * A caller bug must not be able to delete a card, so a size below one falls
 * back to the card's own default. A `null` is covered here too: a destructuring
 * default only fires for `undefined`, so `pageSize = null` also reached the
 * division.
 */
export const pageSizeOr = (pageSize: number | null | undefined, fallback: number): number =>
  typeof pageSize === 'number' && Number.isFinite(pageSize) && pageSize >= 1
    ? Math.floor(pageSize)
    : fallback;