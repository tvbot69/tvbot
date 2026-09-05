require('dotenv').config();
require('reflect-metadata');
const { PrismaClient } = require('@prisma/client');
const { container } = require('tsyringe');

class FakeTracker { trackSuccess() {} trackError() {} }
container.registerInstance(FakeTracker, new FakeTracker());

const prisma = new PrismaClient();
const { ConfigData } = require('../dist/bot/configurations/configData');
console.log('default prefix:', JSON.stringify(ConfigData.Data.bot.prefix));

(async () => {
  const { CacheService } = require('../dist/bot/services/cacheService');
  const { PrefixService } = require('../dist/bot/services/prefixService');
  const { GuildRepository } = require('../dist/persistence/repositories/guildRepository');

  const cache = new CacheService();
  const repo = new GuildRepository(prisma);
  const svc = new PrefixService(cache, repo);

  const resolved = await svc.getPrefix('953703151930847253');
  console.log('resolved guild prefix:', JSON.stringify(resolved));
})()
  .catch((e) => console.error('FAILED:', e.message))
  .finally(() => prisma.$disconnect());
