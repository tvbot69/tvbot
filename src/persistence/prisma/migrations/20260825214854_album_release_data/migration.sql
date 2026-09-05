-- AlterTable
ALTER TABLE "albums" ADD COLUMN     "release_date" DATE,
ADD COLUMN     "release_date_precision" VARCHAR(20),
ADD COLUMN     "spotify_album_type" VARCHAR(20);
