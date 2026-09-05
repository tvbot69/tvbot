-- AlterTable
ALTER TABLE "albums" ALTER COLUMN "name" SET DATA TYPE TEXT;

-- AlterTable
ALTER TABLE "artists" ALTER COLUMN "name" SET DATA TYPE TEXT;

-- AlterTable
ALTER TABLE "tracks" ALTER COLUMN "name" SET DATA TYPE TEXT;

-- AlterTable
ALTER TABLE "user_albums" ALTER COLUMN "name" SET DATA TYPE TEXT;

-- AlterTable
ALTER TABLE "user_artists" ALTER COLUMN "name" SET DATA TYPE TEXT;

-- AlterTable
ALTER TABLE "user_plays" ALTER COLUMN "artist_name" SET DATA TYPE TEXT,
ALTER COLUMN "album_name" SET DATA TYPE TEXT,
ALTER COLUMN "track_name" SET DATA TYPE TEXT;

-- AlterTable
ALTER TABLE "user_tracks" ALTER COLUMN "name" SET DATA TYPE TEXT;
