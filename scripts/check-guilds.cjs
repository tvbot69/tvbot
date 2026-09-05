require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const guilds = await p.guild.findMany({
    select: { guildId: true, guildName: true, prefix: true, accentColor: true },
  });
  for (const g of guilds) {
    console.log('guild', g.guildId.toString(), '| name:', g.guildName, '| prefix:', JSON.stringify(g.prefix), '| accent:', g.accentColor);
  }
  if (guilds.length === 0) console.log('NO GUILD ROWS AT ALL');
})().finally(() => p.$disconnect());
