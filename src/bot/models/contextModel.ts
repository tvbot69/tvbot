import {
  type ChatInputCommandInteraction,
  type Message,
  type Guild,
  GuildMember,
  type Snowflake,
  PermissionFlagsBits,
} from 'discord.js';

export enum ContextType {
  Interaction,
  Message,
}

export class ContextModel {
  public interaction?: ChatInputCommandInteraction;
  public message?: Message;
  public discordUserId!: Snowflake;
  public guildId?: Snowflake;
  public prefix: string = '.';
  public accentColor: number | undefined;
  public args: string[] = [];

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
    return this.interaction?.member instanceof GuildMember
      ? this.interaction.member
      : (this.message?.member ?? null);
  }

  public get userIsGuildAdmin(): boolean {
    return this.member?.permissions.has(PermissionFlagsBits.ManageGuild) ?? false;
  }

  public get guild(): Guild | null {
    return this.interaction?.guild ?? this.message?.guild ?? null;
  }

  public get channelId(): string {
    return this.interaction?.channelId ?? this.message?.channelId ?? '';
  }

  public get channel(): Message['channel'] | ChatInputCommandInteraction['channel'] | null {
    return this.interaction?.channel ?? this.message?.channel ?? null;
  }

  public get discordDisplayName(): string {
    return this.member?.displayName ?? this.interaction?.user.displayName ?? this.message?.author.displayName ?? '';
  }

  public static fromInteraction(interaction: ChatInputCommandInteraction): ContextModel {
    const context = new ContextModel();
    context.interaction = interaction;
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
