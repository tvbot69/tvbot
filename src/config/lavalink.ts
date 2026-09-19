import { Logger } from '@domain/logger';

// Pool management notes (verified live 2026-09-19):
// - Only the two defaults below completed websocket + search handshakes.
//   Public lists are rotten: v4.lavalink.rocks, lavalink-v4.huntolls-bot.xyz,
//   us/eu.lavalink.heavencloud.in are DNS-dead; lavalink.heavencloud.in times
//   out; lavalink.serentia.com is DNS-dead; lavalinkv4-id/eu.serentia.com hang.
// - NEVER add a node without verifying it first: point scratch/probe-nodes.ts
//   at the candidate (identifier/host/port/password/secure), run it with
//   `node node_modules/tsx/dist/cli.mjs scratch/probe-nodes.ts`, and require
//   both [connected] and a nonzero [search] count before listing it here.
// - Operators add/replace nodes without code changes via LAVALINK_NODES JSON:
//   [{"identifier":"Self","host":"1.2.3.4","port":2333,"password":"youshallnotpass","secure":false}]
//   Custom entries are unshifted ahead of the defaults.

export interface LavalinkNodeConfig {
  identifier: string;
  host: string;
  port: number;
  password: string;
  secure?: boolean;
  retryAmount?: number;
  retryDelay?: number;
}

export const defaultPublicNodes: LavalinkNodeConfig[] = [
  {
    identifier: 'MilloHost',
    host: 'lava-v4.millohost.my.id',
    port: 443,
    password: 'https://discord.gg/mjS5J2K3ep',
    secure: true,
    retryAmount: 0,
    retryDelay: 60000,
  },
  {
    identifier: 'Serenetia-SSL',
    host: 'lavalinkv4.serenetia.com',
    port: 443,
    password: 'https://seretia.link/discord',
    secure: true,
    retryAmount: 0,
    retryDelay: 60000,
  },
];

export const getLavalinkNodes = (): LavalinkNodeConfig[] => {
  const nodes: LavalinkNodeConfig[] = [...defaultPublicNodes];

  if (process.env.LAVALINK_NODES) {
    try {
      const parsed = JSON.parse(process.env.LAVALINK_NODES) as LavalinkNodeConfig[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        for (const customNode of parsed) {
          if (customNode.host && customNode.port && customNode.password) {
            const id = customNode.identifier || `Custom-${customNode.host}`;
            const idx = nodes.findIndex((n) => n.identifier === id || n.host === customNode.host);
            if (idx >= 0) {
              nodes[idx] = { ...nodes[idx], ...customNode, identifier: id };
            } else {
              nodes.unshift({
                identifier: id,
                host: customNode.host,
                port: Number(customNode.port),
                password: String(customNode.password),
                secure: customNode.secure ?? customNode.port === 443,
                retryAmount: customNode.retryAmount ?? 5,
                retryDelay: customNode.retryDelay ?? 3000,
              });
            }
          }
        }
      }
    } catch (err) {
      Logger.warn({ err }, 'Failed to parse LAVALINK_NODES env variable, using default nodes');
    }
  }

  if (process.env.LAVALINK_BACKUP_HOST) {
    const backupHost = process.env.LAVALINK_BACKUP_HOST;
    const backupPort = Number(process.env.LAVALINK_BACKUP_PORT || 443);
    const backupPassword = process.env.LAVALINK_BACKUP_PASSWORD || 'youshallnotpass';
    const backupSecure = process.env.LAVALINK_BACKUP_SECURE === 'true' || backupPort === 443;

    nodes.push({
      identifier: 'BackupNode',
      host: backupHost,
      port: backupPort,
      password: backupPassword,
      secure: backupSecure,
      retryAmount: 3,
      retryDelay: 5000,
    });
  }

  return nodes;
};
