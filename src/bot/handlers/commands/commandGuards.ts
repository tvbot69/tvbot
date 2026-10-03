import { GenericEmbedService } from '@bot/services/system/genericEmbedService';
import type { ResponseModel } from '@bot/models/responseModel';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { User } from '@domain/interfaces/ports/iuserRepository';

export interface LinkedUserService {
  getUserByDiscordId(discordUserId: string): Promise<User | null>;
}

export interface EnsureLinkedUserOptions {
  prefix?: string;
  slash?: boolean;
}

export const SLASH_UNLINKED_MESSAGE =
  'You have not connected your Last.fm account yet. Use `/register` first.';

export const textUnlinkedMessage = (prefix: string): string =>
  `You have not connected your Last.fm account yet. Use the \`${prefix}register\` command first.`;

/**
 * Self-guard for every linked-user command. Returns the User when linked,
 * otherwise a not-found ResponseModel with one of the two canonical messages:
 * slash uses `/register`, text uses the guild prefix.
 */
export async function ensureLinkedUser(
  userService: LinkedUserService,
  discordUserId: string,
  opts?: EnsureLinkedUserOptions,
): Promise<User | ResponseModel> {
  const user = await userService.getUserByDiscordId(discordUserId);
  if (user && user.userNameLastFm) return user;
  if (opts?.slash) {
    return GenericEmbedService.buildCommandErrorResponse(
      CommandResponse.NotFound,
      SLASH_UNLINKED_MESSAGE,
    );
  }
  const prefix = opts?.prefix ?? '.';
  return GenericEmbedService.buildCommandErrorResponse(
    CommandResponse.NotFound,
    textUnlinkedMessage(prefix),
  );
}
