import type {
  ModalSubmitInteraction,
} from 'discord.js';
import { Logger } from '@domain/logger';

export type ModalHandler = (interaction: ModalSubmitInteraction) => Promise<void>;

const handlers: Array<{ prefix: string; handler: ModalHandler }> = [];

export const registerModalHandler = (customIdPrefix: string, handler: ModalHandler): void => {
  handlers.push({ prefix: customIdPrefix, handler: handler });
};

export const tryHandleModal = async (interaction: ModalSubmitInteraction): Promise<boolean> => {
  const match = handlers.find((h) => interaction.customId.startsWith(h.prefix));
  if (!match) {
    return false;
  }
  try {
    await match.handler(interaction);
    return true;
  } catch (err) {
    Logger.error({ err }, `Modal handler failed for ${interaction.customId}`);
    return true;
  }
};
