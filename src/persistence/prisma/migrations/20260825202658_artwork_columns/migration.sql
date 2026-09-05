-- AlterTable
ALTER TABLE "albums" ADD COLUMN     "deezer_album_id" BIGINT,
ADD COLUMN     "deezer_image_url" VARCHAR(500),
ADD COLUMN     "lastfm_image_url" VARCHAR(500),
ADD COLUMN     "spotify_image_date" TIMESTAMPTZ(6),
ADD COLUMN     "spotify_image_url" VARCHAR(500);

-- AlterTable
ALTER TABLE "artists" ADD COLUMN     "apple_music_url" VARCHAR(500),
ADD COLUMN     "deezer_artist_id" BIGINT,
ADD COLUMN     "deezer_image_url" VARCHAR(500),
ADD COLUMN     "spotify_image_date" TIMESTAMPTZ(6),
ADD COLUMN     "spotify_image_url" VARCHAR(500);

-- AlterTable
ALTER TABLE "tracks" ADD COLUMN     "image_url" VARCHAR(500),
ADD COLUMN     "spotify_image_date" TIMESTAMPTZ(6),
ADD COLUMN     "spotify_image_url" VARCHAR(500);
