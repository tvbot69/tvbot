import {
  type ChatInputCommandInteraction,
  type Message,
  type Guild,
  GuildMember,
  type Snowflake,
  PermissionFlagsBits,
  PermissionsBitField,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
  type BaseInteraction,
} from 'discord.js';

import { Logger } from '@domain/logger';

export enum ContextType {
  Interaction,
  Message,
}

export class ContextModel {
  public interaction?: ChatInputCommandInteraction;
  public componentInteraction?: ButtonInteraction | StringSelectMenuInteraction;
  public message?: Message;
  public discordUserId!: Snowflake;
  public guildId?: Snowflake;
  public prefix: string = '.';
  public accentColor: number | undefined;
  public args: string[] = [];
  public traceId: string = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

  private get anyInteraction(): BaseInteraction | undefined {
    return this.interaction ?? this.componentInteraction;
  }

  public get logger() {
    return Logger.withContext({
      traceId: this.traceId,
      userId: this.discordUserId,
      guildId: this.guildId,
      commandName: this.interaction?.commandName ?? this.args[0],
    });
  }

  public get contextType(): ContextType {
    return this.interaction ? ContextType.Interaction : ContextType.Message;
  }

  public get isInteraction(): boolean {
    return this.contextType === ContextType.Interaction;
  }

  public get guildIdOrNull(): Snowflake | undefined {
    return this.guildId;
  }

  public get member(): GuildMember | null {
    const inter = this.anyInteraction;
    if (inter && 'member' in inter) {
      if (inter.member instanceof GuildMember) {
        return inter.member;
      }
    }
    return this.message?.member ?? null;
  }

  public get userIsGuildAdmin(): boolean {
    if (!this.guildId) return false;

    // Server owner always has admin permissions
    if (this.guild?.ownerId === this.discordUserId) {
      return true;
    }

    const inter = this.anyInteraction;

    // Interaction memberPermissions (available on all interaction types in guilds)
    if (inter && 'memberPermissions' in inter && inter.memberPermissions) {
      const perms = inter.memberPermissions;
      if (perms.has(PermissionFlagsBits.Administrator) || perms.has(PermissionFlagsBits.ManageGuild)) {
        return true;
      }
    }

    // Cached GuildMember permissions
    if (this.member) {
      const perms = this.member.permissions;
      if (perms.has(PermissionFlagsBits.Administrator) || perms.has(PermissionFlagsBits.ManageGuild)) {
        return true;
      }
    }

    // Fallback: raw API member permissions bitfield
    const rawMember = inter && 'member' in inter ? inter.member : null;
    if (rawMember && typeof rawMember === 'object' && 'permissions' in rawMember) {
      try {
        const bitfield = BigInt((rawMember as { permissions: string | bigint }).permissions);
        const perms = new PermissionsBitField(bitfield);
        if (perms.has(PermissionFlagsBits.Administrator) || perms.has(PermissionFlagsBits.ManageGuild)) {
          return true;
        }
      } catch {
        // ignore
      }
    }

    return false;
  }

  public get guild(): Guild | null {
    const inter = this.anyInteraction;
    return (inter && 'guild' in inter ? (inter.guild as Guild | null) : null) ?? this.message?.guild ?? null;
  }

  public get channelId(): string {
    return this.anyInteraction?.channelId ?? this.message?.channelId ?? '';
  }

  public get channel(): Message['channel'] | ChatInputCommandInteraction['channel'] | null {
    const inter = this.anyInteraction;
    return (inter && 'channel' in inter ? (inter.channel as Message['channel']) : null) ?? this.message?.channel ?? null;
  }

  public get discordDisplayName(): string {
    const inter = this.anyInteraction;
    const interactionUser = inter && 'user' in inter ? (inter.user as { displayName?: string }) : null;
    return this.member?.displayName ?? interactionUser?.displayName ?? this.message?.author.displayName ?? '';
  }

  public static fromInteraction(interaction: ChatInputCommandInteraction): ContextModel {
    const context = new ContextModel();
    context.interaction = interaction;
    context.discordUserId = interaction.user.id;
    context.guildId = interaction.guildId ?? undefined;
    return context;
  }

  public static fromComponentInteraction(interaction: ButtonInteraction | StringSelectMenuInteraction): ContextModel {
    const context = new ContextModel();
    context.componentInteraction = interaction;
    context.discordUserId = interaction.user.id;
    context.guildId = interaction.guildId ?? undefined;
    return context;
  }

  public static fromMessage(message: Message, prefix: string, args: string[]): ContextModel {
    const context = new ContextModel();
    context.message = message;
    context.discordUserId = message.author.id;
    context.guildId = message.guildId ?? undefined;
    context.prefix = prefix;
    context.args = args;
    return context;
  }
}
