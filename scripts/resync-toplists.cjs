require('dotenv').config();
require('reflect-metadata');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

class FakeTracker {
  trackSuccess() {}
  trackError() {}
}

(async () => {
  const { CacheService } = require('../dist/bot/services/cacheService');
  const { UserRepository } = require('../dist/persistence/repositories/userRepository');
  const { ArtistRepository } = require('../dist/persistence/repositories/artistRepository');
  const { AlbumRepository } = require('../dist/persistence/repositories/albumRepository');
  const { TrackRepository } = require('../dist/persistence/repositories/trackRepository');
  const { PlayRepository } = require('../dist/persistence/repositories/playRepository');
  const { UserIndexQueueService } = require('../dist/bot/services/userIndexQueueService');
  const { LastfmApi } = require('../dist/lastfm/api/lastfmApi');
  const { LastFmRepository } = require('../dist/lastfm/repositories/lastFmRepository');
  const { IndexService } = require('../dist/bot/services/indexService');

  container_register();

  function container_register() {
    const { container } = require('tsyringe');
    container.registerInstance(FakeTracker, new FakeTracker());
  }

  const cache = new CacheService();
  const lastFm = new LastFmRepository(new LastfmApi());
  const userRepo = new UserRepository(prisma);
  const artistRepo = new ArtistRepository(prisma);
  const albumRepo = new AlbumRepository(prisma);
  const trackRepo = new TrackRepository(prisma);
  const playRepo = new PlayRepository(prisma);
  const indexQueue = new UserIndexQueueService();

  const service = new IndexService(
    indexQueue,
    cache,
    userRepo,
    artistRepo,
    albumRepo,
    trackRepo,
    playRepo,
    lastFm,
  );

  const user = await prisma.user.findFirst({
    where: { userNameLastFm: 'Moha504' },
    select: { userId: true },
  });
  if (!user) {
    console.log('user not found');
    return;
  }

  console.log('recalculating full top lists for userId', user.userId, '...');
  await service.recalculateTopLists(user.userId);

  const [a, al, t] = await Promise.all([
    prisma.userArtist.count({ where: { userId: user.userId } }),
    prisma.userAlbum.count({ where: { userId: user.userId } }),
    prisma.userTrack.count({ where: { userId: user.userId } }),
  ]);
  console.log('DONE -> artists:', a, '| albums:', al, '| tracks:', t);
})()
  .catch((e) => console.error('FAILED:', e.message))
  .finally(() => prisma.$disconnect());
