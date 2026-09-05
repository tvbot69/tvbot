require('reflect-metadata');
require('dotenv').config();
const { ConfigData } = require('../dist/bot/configurations/configData');
const { SpotifyTokenManager } = require('../dist/spotify/api/spotifyTokenManager');
const { SpotifySearchApi } = require('../dist/spotify/api/spotifySearchApi');
const { DeezerApi } = require('../dist/deezer/apis/deezerApi');
const { AppleMusicSearchApi } = require('../dist/applemusic/apis/appleMusicSearchApi');

ConfigData.Data;

(async () => {
  const tokenManager = new SpotifyTokenManager();
  const token = await tokenManager.getToken();
  console.log('Spotify token acquired:', token ? 'yes (' + token.slice(0, 12) + '...)' : 'NO');

  const spotify = new SpotifySearchApi(tokenManager);
  const albums = await spotify.searchAlbums('Discovery Daft Punk');
  console.log('Spotify album cover:', albums[0]?.images?.[0]?.url ?? 'MISS');

  const artists = await spotify.searchArtists('Daft Punk');
  console.log('Spotify artist pic:', artists[0]?.images?.[0]?.url ?? 'MISS');

  const deezer = new DeezerApi();
  const dArtists = await deezer.searchArtists('Daft Punk');
  console.log('Deezer artist pic_xl:', dArtists[0]?.picture_xl ?? 'MISS');
  const dAlbums = await deezer.searchAlbums('Discovery Daft Punk');
  console.log('Deezer album cover_xl:', dAlbums[0]?.cover_xl ?? 'MISS');

  const itunes = new AppleMusicSearchApi();
  const results = await itunes.searchAlbums('Discovery', 'Daft Punk');
  const art = results.find((r) => r.artworkUrl100)?.artworkUrl100;
  console.log('iTunes album art (600):', art ? art.replace(/\/\d+x\d+bb\./, '/600x600bb.') : 'MISS');
})()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('PROBE FAILED:', err);
    process.exit(1);
  });
