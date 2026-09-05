-- CreateEnum
CREATE TYPE "user_type" AS ENUM ('User', 'Contributor', 'Admin', 'Owner');

-- CreateEnum
CREATE TYPE "data_source" AS ENUM ('LastFm', 'SpotifyImport', 'AppleMusicImport');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "data_source" "data_source" NOT NULL DEFAULT 'LastFm',
ADD COLUMN     "dm_channel_id" BIGINT,
ADD COLUMN     "last_used" TIMESTAMPTZ(6),
ADD COLUMN     "number_format" VARCHAR(10),
ADD COLUMN     "time_zone" VARCHAR(50),
ADD COLUMN     "user_type" "user_type" NOT NULL DEFAULT 'User';
