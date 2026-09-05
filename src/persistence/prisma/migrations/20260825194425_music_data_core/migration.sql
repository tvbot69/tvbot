-- CreateEnum
CREATE TYPE "PlaySource" AS ENUM ('LastFm', 'SpotifyImport', 'AppleMusicImport');

-- CreateTable
CREATE TABLE "artists" (
    "artist_id" SERIAL NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "mbid" VARCHAR(36),
    "last_fm_url" VARCHAR(500),
    "image_url" VARCHAR(500),
    "popularity" INTEGER,
    "created_on" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artists_pkey" PRIMARY KEY ("artist_id")
);

-- CreateTable
CREATE TABLE "albums" (
    "album_id" SERIAL NOT NULL,
    "artist_id" INTEGER NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "mbid" VARCHAR(36),
    "image_url" VARCHAR(500),
    "created_on" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "albums_pkey" PRIMARY KEY ("album_id")
);

-- CreateTable
CREATE TABLE "tracks" (
    "track_id" SERIAL NOT NULL,
    "artist_id" INTEGER NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "mbid" VARCHAR(36),
    "created_on" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tracks_pkey" PRIMARY KEY ("track_id")
);

-- CreateTable
CREATE TABLE "user_plays" (
    "user_play_id" BIGSERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "artist_id" INTEGER,
    "album_id" INTEGER,
    "track_id" INTEGER,
    "artist_name" VARCHAR(750) NOT NULL,
    "album_name" VARCHAR(750),
    "track_name" VARCHAR(750),
    "time_played" TIMESTAMPTZ(3) NOT NULL,
    "ms_played" INTEGER,
    "play_source" "PlaySource",

    CONSTRAINT "user_plays_pkey" PRIMARY KEY ("user_play_id")
);

-- CreateTable
CREATE TABLE "user_artists" (
    "user_id" INTEGER NOT NULL,
    "artist_id" INTEGER NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "playcount" INTEGER NOT NULL,

    CONSTRAINT "user_artists_pkey" PRIMARY KEY ("user_id","artist_id")
);

-- CreateTable
CREATE TABLE "user_albums" (
    "user_id" INTEGER NOT NULL,
    "album_id" INTEGER NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "playcount" INTEGER NOT NULL,

    CONSTRAINT "user_albums_pkey" PRIMARY KEY ("user_id","album_id")
);

-- CreateTable
CREATE TABLE "user_tracks" (
    "user_id" INTEGER NOT NULL,
    "track_id" INTEGER NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "playcount" INTEGER NOT NULL,

    CONSTRAINT "user_tracks_pkey" PRIMARY KEY ("user_id","track_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "artists_name_key" ON "artists"("name");

-- CreateIndex
CREATE UNIQUE INDEX "albums_artist_id_name_key" ON "albums"("artist_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "tracks_artist_id_name_key" ON "tracks"("artist_id", "name");

-- CreateIndex
CREATE INDEX "user_plays_user_id_time_played_idx" ON "user_plays"("user_id", "time_played");

-- CreateIndex
CREATE INDEX "user_plays_user_id_artist_id_idx" ON "user_plays"("user_id", "artist_id");

-- CreateIndex
CREATE INDEX "user_plays_time_played_idx" ON "user_plays"("time_played");

-- CreateIndex
CREATE INDEX "user_artists_user_id_playcount_idx" ON "user_artists"("user_id", "playcount");

-- CreateIndex
CREATE INDEX "user_albums_user_id_playcount_idx" ON "user_albums"("user_id", "playcount");

-- CreateIndex
CREATE INDEX "user_tracks_user_id_playcount_idx" ON "user_tracks"("user_id", "playcount");

-- AddForeignKey
ALTER TABLE "albums" ADD CONSTRAINT "albums_artist_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "artists"("artist_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_artist_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "artists"("artist_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_plays" ADD CONSTRAINT "user_plays_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_artists" ADD CONSTRAINT "user_artists_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_artists" ADD CONSTRAINT "user_artists_artist_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "artists"("artist_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_albums" ADD CONSTRAINT "user_albums_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_albums" ADD CONSTRAINT "user_albums_album_id_fkey" FOREIGN KEY ("album_id") REFERENCES "albums"("album_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_tracks" ADD CONSTRAINT "user_tracks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_tracks" ADD CONSTRAINT "user_tracks_track_id_fkey" FOREIGN KEY ("track_id") REFERENCES "tracks"("track_id") ON DELETE RESTRICT ON UPDATE CASCADE;
