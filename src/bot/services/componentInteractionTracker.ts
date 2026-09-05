import {
  type AnySelectMenuInteraction,
  type ButtonInteraction,
  type Interaction,
} from 'discord.js';
import { Logger } from '@domain/logger';

export type ComponentInteraction = ButtonInteraction | AnySelectMenuInteraction;
export type ComponentHandler = (interaction: ComponentInteraction) => Promise<void>;

interface TrackedHandler {
  handler: ComponentHandler;
  expiresAt: number;
}

export class ComponentInteractionTracker {
  private readonly handlers: Map<string, TrackedHandler> = new Map();
  private cleanupTimer: NodeJS.Timeout | null = null;

  public register(customId: string, handler: ComponentHandler, ttlMs: number = 300000): void {
    this.handlers.set(customId, { handler: handler, expiresAt: Date.now() + ttlMs });
    this.ensureCleanupTimer();
  }

  public async handle(interaction: Interaction): Promise<boolean> {
    if (!interaction.isButton() && !interaction.isAnySelectMenu()) {
      return false;
    }
    const tracked = this.handlers.get(interaction.customId);
    if (!tracked) {
      return false;
    }
    if (tracked.expiresAt < Date.now()) {
      this.handlers.delete(interaction.customId);
      return false;
    }
    try {
      await tracked.handler(interaction);
    } catch (err: any) {
      // 10062 Unknown interaction is expected when user clicks after 3s or bot lagged — don't spam ERROR
      if (err?.code === 10062 || String(err?.message).includes('Unknown interaction')) {
        Logger.debug({ err: String(err).slice(0, 120), customId: interaction.customId }, 'Component interaction expired');
        return true;
      }
      Logger.error({ err }, 'Component interaction handler failed');
    }
    return true;
  }

  private ensureCleanupTimer(): void {
    if (this.cleanupTimer) {
      return;
    }
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, tracked] of this.handlers) {
        if (tracked.expiresAt < now) {
          this.handlers.delete(id);
        }
      }
      if (this.handlers.size === 0 && this.cleanupTimer) {
        clearInterval(this.cleanupTimer);
        this.cleanupTimer = null;
      }
    }, 60000);
  }
}
