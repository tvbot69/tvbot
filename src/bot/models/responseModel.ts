import {
  ActionRowBuilder,
  EmbedBuilder,
  ContainerBuilder,
  MessageFlags,
  type APIEmbed,
  type JSONEncodable,
  type MessageActionRowComponentBuilder,
} from 'discord.js';
import { CommandResponse } from '@domain/enums/commandResponse';
import { DiscordConstants } from '@bot/resources/discordConstants';

export class ResponseModel {
  public commandResponse: CommandResponse = CommandResponse.Ok;
  public embed: EmbedBuilder;
  public embedAuthorName?: string;
  public embedAuthorIconUrl?: string;
  public embedAuthorUrl?: string;
  public buttonRows: Map<number, ActionRowBuilder<MessageActionRowComponentBuilder>[]> =
    new Map();
  public spoiler: boolean = false;
  public fileBuffer?: Buffer;
  public fileName?: string;
  public fileDescription?: string;
  public componentsV2Container?: ContainerBuilder;
  public content?: string;
  public _textContent?: string;

  public additionalEmbeds: EmbedBuilder[] = [];

  constructor(color?: number | null) {
    this.embed = new EmbedBuilder();
    if (color !== undefined && color !== null) {
      this.embed.setColor(color);
    }
  }

  public addEmbed(...embeds: EmbedBuilder[]): this {
    this.additionalEmbeds.push(...embeds);
    return this;
  }

  public get isComponentsV2(): boolean {
    return this.componentsV2Container !== undefined;
  }

  public setComponentsV2Container(container: ContainerBuilder): this {
    this.componentsV2Container = container;
    return this;
  }

  public setFile(buffer: Buffer, name: string, description?: string): this {
    this.fileBuffer = buffer;
    this.fileName = name;
    this.fileDescription = description;
    return this;
  }

  public hasFile(): boolean {
    return this.fileBuffer !== undefined && this.fileName !== undefined;
  }

  public setAuthor(name: string, iconUrl?: string, url?: string): this {
    this.embedAuthorName = name;
    this.embedAuthorIconUrl = iconUrl;
    this.embedAuthorUrl = url;
    return this;
  }

  public setContent(content: string): this {
    this.content = content;
    return this;
  }

  public addButtonRow(
    row: number,
    ...rows: ActionRowBuilder<MessageActionRowComponentBuilder>[]
  ): this {
    const existing = this.buttonRows.get(row) ?? [];
    this.buttonRows.set(row, [...existing, ...rows]);
    return this;
  }

  public buildEmbed(): JSONEncodable<APIEmbed>[] | APIEmbed[] {
    if (this.embedAuthorName) {
      this.embed.setAuthor({
        name: this.embedAuthorName,
        iconURL: this.embedAuthorIconUrl,
        url: this.embedAuthorUrl,
      });
    }
    return [...this.additionalEmbeds, this.embed];
  }

  public buildComponents(): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
    const sortedRows = [...this.buttonRows.entries()].sort((a, b) => a[0] - b[0]);
    return sortedRows.flatMap(([, rows]) => rows);
  }

  public hasContent(): boolean {
    return (
      this.content !== undefined ||
      this.embed.data.title !== undefined ||
      this.embed.data.description !== undefined ||
      (this.embed.data.fields?.length ?? 0) > 0 ||
      this.embed.data.image !== undefined ||
      this.embed.data.thumbnail !== undefined ||
      this.additionalEmbeds.length > 0
    );
  }

  public hasEmbed(): boolean {
    return (
      this.additionalEmbeds.length > 0 ||
      !!(
        this.embed.data.title ||
        this.embed.data.description ||
        (this.embed.data.fields && this.embed.data.fields.length > 0) ||
        this.embed.data.image ||
        this.embed.data.thumbnail ||
        this.embed.data.author
      )
    );
  }

  public toMessagePayload(): Record<string, unknown> {
    if (this.isComponentsV2) {
      const payload: Record<string, unknown> = {
        components: [this.componentsV2Container],
        flags: MessageFlags.IsComponentsV2,
      };
      if (this.hasFile()) {
        payload.files = [
          {
            attachment: this.fileBuffer,
            name: this.fileName,
            description: this.fileDescription,
          },
        ];
      }
      return payload;
    }

    const hasEmbed = this.hasEmbed();
    const payload: Record<string, unknown> = {
      content: this.content ?? (hasEmbed ? undefined : this._textContent),
      embeds: hasEmbed ? this.buildEmbed() : [],
      components: this.buildComponents(),
    };
    if (!payload.content && this._textContent) payload.content = this._textContent;
    if (!hasEmbed && payload.content) delete payload.embeds;
    if (this.hasFile()) {
      payload.files = [
        {
          attachment: this.fileBuffer,
          name: this.fileName,
          description: this.fileDescription,
        },
      ];
    }
    return payload;
  }
}
