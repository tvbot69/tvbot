import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');
import 'reflect-metadata';
import path from 'path';
import { ShardingManager } from 'discord.js';
import { ConfigData } from '@bot/configurations/configData';
import { Logger } from '@domain/logger';

/**
 * Decides entry mode. Default is the current single-process worker (Railway,
 * dev, small bots). Set SHARDING_ENABLED=true (or SHARD_COUNT>1) to boot the
 * manager, which spawns one shardWorker process per shard.
 */
export const shouldShard = (env: NodeJS.ProcessEnv = process.env): boolean => {
  if (env.SHARDING_ENABLED === 'true') return true;
  if (env.SHARDING_ENABLED === 'false') return false;
  const count = Number(env.SHARD_COUNT ?? '');
  return Number.isFinite(count) && count > 1;
};

export const runShardManager = async (): Promise<ShardingManager> => {
  const token = ConfigData.Data.discord.token;
  if (!token) {
    throw new Error('Cannot start sharding: DISCORD_TOKEN is missing');
  }

  const totalShards: number | 'auto' = (() => {
    const count = Number(process.env.SHARD_COUNT ?? '');
    return Number.isFinite(count) && count > 0 ? Math.floor(count) : 'auto';
  })();

  const manager = new ShardingManager(path.join(__dirname, 'shardWorker.js'), {
    token,
    totalShards,
    mode: 'process',
    respawn: true,
  });

  manager.on('shardCreate', (shard) => {
    Logger.info(`Shard ${shard.id} created — launching worker...`);
    shard.on('ready', () => Logger.ready(`Shard ${shard.id} ready`));
    shard.on('disconnect', () => Logger.warn(`Shard ${shard.id} disconnected`));
    shard.on('reconnecting', () => Logger.info(`Shard ${shard.id} reconnecting...`));
    shard.on('death', () => Logger.error(`Shard ${shard.id} died — respawning`));
    shard.on('error', (err: unknown) => Logger.error({ err }, `Shard ${shard.id} error`));
  });

  Logger.info(`Spawning shards (totalShards=${String(totalShards)})...`);
  await manager.spawn();
  return manager;
};

// Manager entrypoint (runs in the parent process when index.ts routes here).
if (require.main === module) {
  runShardManager().catch((err) => {
    Logger.fatal({ err }, 'Fatal error during shard manager startup, exiting...');
    process.exit(1);
  });
}
