import type { JSONEncodable, RESTPostAPIApplicationCommandsJSONBody } from 'discord.js';
import type { ContextModel } from './contextModel';
import type { ResponseModel } from './responseModel';

export type SlashCommandData = JSONEncodable<RESTPostAPIApplicationCommandsJSONBody> & {
  readonly name: string;
};

export interface SlashCommandDefinition {
  data: SlashCommandData;
  executeAsync(context: ContextModel): Promise<ResponseModel>;
  ephemeral?: boolean;
}

export interface ISlashCommandModule {
  commands: SlashCommandDefinition[];
}

export interface TextCommandDefinition {
  name: string;
  aliases?: string[];
  executeAsync(context: ContextModel, args: string[]): Promise<ResponseModel>;
}

export interface ITextCommandModule {
  commands: TextCommandDefinition[];
}
