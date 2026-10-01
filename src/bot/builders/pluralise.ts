/**
 * Picks the noun form that agrees with `count`.
 *
 * A card that says "1 listeners" or "1 entries" asserts something the data does
 * not support: it claims there was more than one thing when the count says
 * there was one. Every call site here formats its own number (some with
 * `toLocaleString()`, some not), so this returns the WORD only and never
 * touches the count — changing the number format would be a separate, and
 * unwanted, diff.
 *
 * `pluralForm` is only needed for irregular plurals; the default is `+s`.
 */
export const pluralise = (
  count: number,
  singular: string,
  pluralForm: string = `${singular}s`,
): string => (count === 1 ? singular : pluralForm);