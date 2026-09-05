require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  const plays = await p.userPlay.count();
  const artists = await p.artist.count();
  const albums = await p.album.count();
  const tracks = await p.track.count();
  const u = await p.user.findFirst({ where: { userNameLastFm: 'Moha504' }, select: { userId: true, totalPlayCount: true, lastIndexed: true } });
  const uArtists = await p.userArtist.count({ where: { userId: u.userId } });
  const uAlbums = await p.userAlbum.count({ where: { userId: u.userId } });
  const uTracks = await p.userTrack.count({ where: { userId: u.userId } });

  console.log('user_plays:', plays);
  console.log('catalog -> artists:', artists, '| albums:', albums, '| tracks:', tracks);
  console.log('your top lists -> artists:', uArtists, '| albums:', uAlbums, '| tracks:', uTracks);
  console.log('users.total_play_count:', u.totalPlayCount, '| lastIndexed:', u.lastIndexed?.toISOString());

  const top5 = await p.userArtist.findMany({
    where: { userId: u.userId },
    orderBy: { playcount: 'desc' },
    take: 5,
  });
  console.log('top 5 artists:', top5.map((t) => t.name + ' (' + t.playcount + ')').join(', '));
})()
  .catch((e) => console.error('FAILED:', e.message))
  .finally(() => p.$disconnect());
