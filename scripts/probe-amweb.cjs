require('reflect-metadata');
require('dotenv').config();
const { AppleMusicTokenScraper } = require('../dist/applemusic/apis/appleMusicTokenScraper');
const { extractTokenFromHtml } = require('../dist/applemusic/apis/appleMusicTokenScraper');
const { AppleMusicWebApi } = require('../dist/applemusic/apis/appleMusicWebApi');

(async () => {
  const scraper = new AppleMusicTokenScraper();
  const token = await scraper.getToken();
  console.log('AM web token:', token ? 'yes (' + token.slice(0, 24) + '...)' : 'MISS');

  const api = new AppleMusicWebApi(scraper);
  const albums = await api.searchAlbums('Discovery', 'Daft Punk', 2, 3000);
  console.log('AM web album:', albums[0]?.name, '| art:', albums[0]?.artwork?.url ?? 'MISS');

  const artists = await api.searchArtists('Daft Punk', 2, 3000);
  console.log('AM web artist pic:', artists[0]?.artwork?.url ?? 'MISS');

  console.log('extract fn sanity:', extractTokenFromHtml('<html>"token":"eyabc.def.ghi"</html>') !== null);
})()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('PROBE FAILED:', err);
    process.exit(1);
  });
