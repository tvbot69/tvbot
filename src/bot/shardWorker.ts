import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');
import 'reflect-metadata';
import { Logger } from '@domain/logger';
import { Startup } from './startup';

// Single shard worker process. Spawned once per shard by shardManager.ts, or
// run directly (unsharded single-process mode — today's default).
// Owns: one discord.js Client (≤2500 guilds), one Moonlink manager, one set of
// timers. Cross-shard state lives in Redis/Postgres, never in memory here.
Startup.runAsync().catch((err) => {
  Logger.fatal({ err }, 'Fatal error during shard worker startup, exiting...');
  process.exit(1);
});
