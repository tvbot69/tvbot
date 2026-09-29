import type { ModalSubmitInteraction } from 'discord.js';
import { Logger } from '@domain/logger';
import { errorMessage } from '@domain/discordErrors';

/**
 * Answering a modal submit.
 *
 * WHY THIS EXISTS - and the honest version, because the first draft of this
 * file got it wrong.
 *
 * I originally wrote that a `ModalSubmitInteraction` has no `update()` method,
 * and that the page-jump handlers were therefore completely broken. That was
 **wrong, and I only found out by reading the runtime prototype rather than
 * the typings:
 *
 *   ModalSubmitInteraction.prototype.update   -> EXISTS
 *   declared in discord.js typings for it    -> DOES NOT
 *
 * `update()` is a real, working method that discord.js kept from v13 but never
 * declared in the v14 typings. So the old `(interaction as any).update(...)`
 * call did work at runtime. My "it throws a TypeError synchronously" reasoning
 * was wrong too: `update` is an async method, so it returns a promise and the
 * trailing `.catch()` attached to it perfectly well.
 *
 * What is actually wrong, and what this fixes:
 *
 *  1. `update()` is UNDOCUMENTED on a modal. Calling it required an `as any`,
 *     which is exactly how a discord.js upgrade silently breaks a feature: the
 *     method can be removed in a minor release without a type error, because
 *     nothing in the type system was ever protecting it. The supported way to
 *     show a result for a modal is `deferReply()` then `editReply()`, and that
 *     is what this uses.
 *
 *  2. The 3-second window was genuinely at risk. Both handlers awaited a
 *     Last.fm fetch BEFORE responding. Discord allows a modal submit 3 seconds
 *     to be answered, so a slow upstream turned a page jump into a 10062.
 *     Deferring first makes the handler's own latency irrelevant.
 *
 *  3. `isFromMessage()` is a TYPE GUARD on the base Interaction, so inside
 *     `if (interaction.isFromMessage())` TypeScript narrows a modal to a type
 *     that has `update()`. That narrowing is what makes
 *     `componentPaginatorService` compile while calling an undeclared method -
 *     the type system gives false confidence here rather than false safety.
 *     Worth knowing before anyone reads that code as blessed.
 */

/**
 * The subset of a built `ResponseModel` this helper needs: just
 * `toMessagePayload`, which already owns the Components V2 vs embeds decision,
 * the no-embed case, and attached files. Reimplementing any of that here is how
 * the two jump handlers drifted apart in the first place.
 */
export interface ModalPagePayload {
  toMessagePayload: () => Record<string, unknown>;
}

/**
 * Defer, then show `page` as the modal's response.
 *
 * Uses only documented API. Safe to call after the handler has already
 * deferred - a second `deferReply` is swallowed, and the `editReply` still
 * lands.
 *
 * @returns true if the page was delivered, false if Discord rejected it (an
 *   expired token, most often).
 */
export const respondToModalWithPage = async (
  interaction: ModalSubmitInteraction,
  page: ModalPagePayload,
): Promise<boolean> => {
  // Before any await, and before the caller does its slow lookups.
  //
  // CORRECT AS IS, and the reason is stated in the module note above: this
  // function may be called after the handler has already deferred, and a second
  // `deferReply` throws 40060. The catch is what makes this helper safe to call
  // from both the "fresh modal" and the "already deferred" paths, which is the
  // entire reason it exists. There is no data read here at all - `page` was
  // already built by the caller - so nothing measured can be lost.
  await interaction.deferReply().catch(() => undefined);
  try {
    await interaction.editReply(page.toMessagePayload());
    return true;
  } catch (err) {
    // The user is left on the deferred "thinking..." state, which is the
    // correct failure mode: a visible spinner beats a modal that vanished.
    // Almost always 10062, an expired token, so WARN rather than ERROR -
    // there is nothing for the operator to do.
    Logger.warn(
      { err: errorMessage(err, 160), customId: interaction.customId },
      '[Interactions] Modal page could not be shown',
    );
    return false;
  }
};
