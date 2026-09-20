import { Logger } from '@domain/logger';

/**
 * Structured audit trail for sensitive guild mutations (blocks, autoposts,
 * settings changes). Every command execution is already logged with actor +
 * guild; this adds an explicit, greppable record for destructive or
 * user-targeting actions.
 */
export const auditAdminAction = (
  guildId: string | undefined,
  actorDiscordId: string | undefined,
  action: string,
  details?: string,
): void => {
  Logger.info({ guildId, actorDiscordId, action, details }, `[AdminAudit] ${action}`);
};
