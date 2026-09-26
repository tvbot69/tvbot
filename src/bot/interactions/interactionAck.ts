import type {
  ButtonInteraction,
  MessageFlagsResolvable,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
} from 'discord.js';

/**
 * Interaction acknowledgement helpers.
 *
 * A single global "ack guard" defers slow components at 2.5s so Discord's 3s
 * window cannot expire. That races the handler's OWN defer: when the guard
 * wins, the handler's `deferUpdate()` throws 40060
 * (InteractionAlreadyAcknowledged), the handler aborts before doing any
 * work, and the press is silently lost — the user pressed pause and nothing
 * happened, with no error anywhere.
 *
 * These helpers treat the acknowledgement as idempotent: if someone already
 * acknowledged, carry on with the work instead of throwing.
 */
type AnyComponentInteraction = ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction;

/** Defer an update/edit. Never throws, even if already acknowledged. */
export const deferUpdateSafe = async (interaction: AnyComponentInteraction): Promise<void> => {
  try {
    await interaction.deferUpdate();
  } catch {
    // Already acknowledged by the ack guard (or a duplicate press) — the work
    // still needs to run, so this is not an error.
  }
};

/** Defer a reply. Never throws, even if already acknowledged. */
export const deferReplySafe = async (
  interaction: AnyComponentInteraction,
  opts?: { ephemeral?: boolean; flags?: MessageFlagsResolvable },
): Promise<void> => {
  try {
    // The option shapes differ across interaction types (modal vs button vs
    // select); pass through only what was supplied.
    await interaction.deferReply(
      (opts ?? {}) as Parameters<AnyComponentInteraction['deferReply']>[0],
    );
  } catch {
    // Already acknowledged — see deferUpdateSafe.
  }
};

/**
 * Send a user-facing payload whether or not the interaction is still
 * unacknowledged. After an auto-defer a plain `reply()` throws, which is how
 * "Only the requester can control playback" and "You must be in a voice
 * channel" messages vanished exactly when the bot was slow.
 */
export const respondSafe = async (
  interaction: AnyComponentInteraction,
  payload: { content?: string; embeds?: unknown[]; flags?: MessageFlagsResolvable },
): Promise<void> => {
  try {
    if (interaction.deferred) {
      await interaction.editReply(payload as never);
      return;
    }
    await interaction.reply(payload as never);
  } catch {
    // Interaction expired or already answered — nothing useful to do.
  }
};

/** Same intent as respondSafe, for follow-ups after a defer. */
export const followUpSafe = async (
  interaction: AnyComponentInteraction,
  payload: { content?: string; embeds?: unknown[]; flags?: MessageFlagsResolvable },
): Promise<void> => {
  try {
    if (interaction.deferred) {
      await interaction.editReply(payload as never);
      return;
    }
    await interaction.followUp(payload as never);
  } catch {
    // Interaction expired or already answered.
  }
};
