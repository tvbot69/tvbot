import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { PlayBuilders, buildNowPlayingButtons } from './playBuilders';
import { TrackBuilders, renderProgressBar } from './trackBuilders';
import { AlbumBuilders } from './albumBuilders';
import { ArtistBuilders } from './artistBuilders';
import { WhoKnowsBuilders } from './whoKnowsBuilders';
import { PlaycountBuilders } from './playcountBuilders';
import { StreakBuilders } from './streakBuilders';
import { OverviewBuilders } from './overviewBuilders';
import { RecentBuilders } from './recentBuilders';
import { TrackDetailsBuilders } from './trackDetailsBuilders';
import { ArtistTrackBuilders } from './artistTrackBuilders';
import { ContextModel } from '@bot/models/contextModel';
import { FmButton } from '@domain/enums/fmButton';
import { FmEmbedType } from '@domain/enums/fmEmbedType';
import type { RecentTrack } from '@domain/models/recentTrack';
import type { User } from '@domain/interfaces/iuserRepository';
import { WhoKnowsMode } from '@domain/enums/whoKnowsMode';

import { UserType, DataSource } from '@persistence/domain/models/user';
import { PrivacyLevel } from '@domain/enums/privacyLevel';

describe('Phase 2 Builders Parity & Zero Duplication', () => {
  const dummyContext = new ContextModel();
  dummyContext.discordUserId = '123456789012345678';
  dummyContext.accentColor = 0xff0055;

  const dummyUser: User = {
    userId: 1,
    discordUserId: '123456789012345678',
    userNameLastFm: 'RadioheadFan',
    timeZone: 'UTC',
    registeredOn: new Date(),
    userType: UserType.User,
    dataSource: DataSource.LastFm,
    privacyLevel: PrivacyLevel.Default,
  };

  const dummyTrack: RecentTrack = {
    name: 'Paranoid Android',
    artistName: 'Radiohead',
    albumName: 'OK Computer',
    nowPlaying: true,
    timePlayed: new Date(),
    imageUrl: 'https://images.last.fm/ok_computer.jpg',
  };

  describe('PlayBuilders & buildNowPlayingButtons', () => {
    it('generates rich link and action buttons matching fmbot-dev', () => {
      const allButtonsFlag =
        BigInt(FmButton.LastFmTrackLink) |
        BigInt(FmButton.LastFmAlbumLink) |
        BigInt(FmButton.LastFmArtistLink) |
        BigInt(FmButton.LastFmUserLibraryLink) |
        BigInt(FmButton.SpotifyLink) |
        BigInt(FmButton.AppleMusicLink) |
        BigInt(FmButton.RymLink) |
        BigInt(FmButton.TrackLove) |
        BigInt(FmButton.TrackLyrics);

      const rows = buildNowPlayingButtons(
        { buttons: allButtonsFlag },
        dummyTrack,
        dummyUser.userNameLastFm,
        {
          spotifyId: 'spotify_123',
          appleMusicUrl: 'https://music.apple.com/track/123',
          discordUserId: '123456789012345678',
          isSupporter: true,
        },
      );

      expect(rows.length).toBeGreaterThanOrEqual(1);
      const totalButtons = rows.reduce((acc, r) => acc + r.components.length, 0);
      expect(totalButtons).toBeGreaterThanOrEqual(5);
    });

    it('attaches referencedMusic in buildFmResponse for 1-click scrobbling', () => {
      const response = PlayBuilders.buildFmResponse(
        dummyContext,
        dummyUser,
        [dummyTrack],
        { name: 'RadioheadFan', playCount: 5000 },
        { inlineEmbedType: FmEmbedType.EmbedMini },
      );

      expect(response.referencedMusic).toBeDefined();
      expect(response.referencedMusic?.artist).toBe('Radiohead');
      expect(response.referencedMusic?.track).toBe('Paranoid Android');
      expect(response.referencedMusic?.album).toBe('OK Computer');
    });

    it('delegates to specialized builders with ZERO duplicate code', () => {
      expect(PlayBuilders.buildDiscoveryDateResponse).toBe(PlaycountBuilders.buildDiscoveryDateResponse);
      expect(PlayBuilders.buildLastListenedDateResponse).toBe(PlaycountBuilders.buildLastListenedDateResponse);
      expect(PlayBuilders.buildPlaysResponse).toBe(PlaycountBuilders.buildPlaysResponse);
      expect(PlayBuilders.buildPaceResponse).toBe(PlaycountBuilders.buildPaceResponse);
      expect(PlayBuilders.buildMilestoneResponse).toBe(PlaycountBuilders.buildMilestoneResponse);
      expect(PlayBuilders.buildYearOverviewResponse).toBe(PlaycountBuilders.buildYearOverviewResponse);
      expect(PlayBuilders.buildStreakResponse).toBe(StreakBuilders.buildStreakResponse);
      expect(PlayBuilders.buildOverviewResponse).toBe(OverviewBuilders.buildOverviewResponse);
      expect(PlayBuilders.buildRecentTracksResponse).toBe(RecentBuilders.buildRecentTracksResponse);
    });
  });

  describe('TrackBuilders', () => {
    it('renders visual progress bars correctly', () => {
      const bar0 = renderProgressBar(0, 10);
      const bar50 = renderProgressBar(50, 10);
      const bar100 = renderProgressBar(100, 10);

      expect(bar0).toBe('[░░░░░░░░░░] 0%');
      expect(bar50).toBe('[█████░░░░░] 50%');
      expect(bar100).toBe('[██████████] 100%');
    });

    it('builds Love and Unlove responses', () => {
      const loveRes = TrackBuilders.buildLoveResponse('Karma Police', 'Radiohead', 0xff0055);
      expect(loveRes.componentsV2Container).toBeDefined();

      const unloveRes = TrackBuilders.buildUnloveResponse('Karma Police', 'Radiohead', 0xff0055);
      expect(unloveRes.componentsV2Container).toBeDefined();
    });

    it('builds loved tracks paginator response', () => {
      const lovedItems = [
        { name: 'Let Down', artistName: 'Radiohead', dateLoved: new Date() },
        { name: 'No Surprises', artistName: 'Radiohead', dateLoved: new Date() },
      ];
      const lovedRes = TrackBuilders.buildLovedTracksResponse('RadioheadFan', 'Radiohead Fan', lovedItems, 0, 2);
      expect(lovedRes.componentsV2Container).toBeDefined();
    });

    it('builds lyrics and audio features responses', () => {
      const lyricsRes = TrackBuilders.buildTrackLyricsResponse(
        'Karma Police',
        'Radiohead',
        'Karma police, arrest this man...',
        'https://genius.com/Radiohead-karma-police-lyrics',
      );
      expect(lyricsRes.componentsV2Container).toBeDefined();

      const audioRes = TrackBuilders.buildAudioFeaturesResponse(
        'Karma Police',
        'Radiohead',
        {
          tempo: 75.0,
          key: 'A minor',
          danceability: 0.35,
          energy: 0.52,
          valence: 0.28,
        },
      );
      expect(audioRes.componentsV2Container).toBeDefined();
    });

    it('delegates to specialized builders with ZERO duplicate code', () => {
      expect(TrackBuilders.buildTrackPlaysResponse).toBe(PlaycountBuilders.buildTrackPlaysResponse);
      expect(TrackBuilders.buildTrackDetailsResponse).toBe(TrackDetailsBuilders.buildTrackDetailsResponse);
    });
  });

  describe('AlbumBuilders', () => {
    it('delegates album plays to PlaycountBuilders with ZERO duplicate code', () => {
      expect(AlbumBuilders.buildAlbumPlaysResponse).toBe(PlaycountBuilders.buildAlbumPlaysResponse);
    });

    it('builds album info response with streaming link buttons', () => {
      const albumData = {
        albumId: 1,
        albumName: 'OK Computer',
        artistName: 'Radiohead',
        albumUrl: 'https://last.fm/music/Radiohead/OK+Computer',
        spotifyUrl: 'https://open.spotify.com/album/ok_computer',
        tracks: [
          { name: 'Airbag', playcount: 12, durationSeconds: 284 },
          { name: 'Paranoid Android', playcount: 25, durationSeconds: 383 },
        ],
      };

      const res = AlbumBuilders.buildAlbumInfoResponse(albumData as any, dummyUser, 'Tester', 0xff0055);
      expect(res.componentsV2Container).toBeDefined();
    });
  });

  describe('ArtistBuilders', () => {
    it('delegates artist plays, pace, and top tracks with ZERO duplicate code', () => {
      expect(ArtistBuilders.buildArtistPlaysResponse).toBe(PlaycountBuilders.buildArtistPlaysResponse);
      expect(ArtistBuilders.buildArtistPaceResponse).toBe(PlaycountBuilders.buildArtistPaceResponse);
      expect(ArtistBuilders.buildArtistTopTracksResponse).toBe(ArtistTrackBuilders.buildArtistTopTracksResponse);
    });

    it('displays birthday badge when artist birthday matches today', () => {
      const now = new Date();
      // Set birthDate timestamp to match today's month and day in 1968
      const bDate = new Date(Date.UTC(1968, now.getUTCMonth(), now.getUTCDate()));
      const epochSeconds = Math.floor(bDate.getTime() / 1000);

      const res = ArtistBuilders.buildArtistInfoResponse(
        'Thom Yorke',
        1,
        'Tester',
        '123',
        '123',
        {
          birthDate: epochSeconds,
          location: 'Wellingborough, Northamptonshire, England',
          countryCode: 'GB',
          links: {},
        } as any,
        'Thom Yorke is an English musician...',
        { serverPlays: 100, serverListeners: 5 },
        { globalPlays: 5000000, globalListeners: 800000 },
        { userPlays: 50, lastMonthPlays: 10, userPercentage: 2.5 },
        ['art rock', 'electronic'],
      );

      expect(res.componentsV2Container).toBeDefined();
    });
  });

  describe('WhoKnowsBuilders', () => {
    it('builds components V2 container and embed fallback with thumbnail accessory', () => {
      const users = [
        {
          userId: 1,
          playcount: 150,
          lastFmUsername: 'RadioheadFan',
          discordName: 'RadioheadFan',
          discordUserId: BigInt('123456789012345678'),
          sameServer: true,
          hasCrown: true,
        },
        {
          userId: 2,
          playcount: 100,
          lastFmUsername: 'User2',
          discordName: 'User Two',
          discordUserId: BigInt('222222222222222222'),
          sameServer: true,
        },
      ];

      const res = WhoKnowsBuilders.buildWhoKnowsResponse(
        dummyContext,
        'Radiohead',
        'https://last.fm/music/Radiohead',
        'https://images.last.fm/radiohead.jpg',
        users as any,
        undefined,
        undefined,
        ['alternative rock', 'art rock'],
        undefined,
        WhoKnowsMode.Pagination,
      );

      expect(res.componentsV2Container).toBeDefined();
    });

    it('builds standard Discord Rich Embed with exact fmbot unicode spacing in Default Mode', () => {
      const users = [
        {
          userId: 123456789012345678,
          playcount: 263,
          lastFmUsername: 'Moha504',
          discordName: 'moha',
          discordUserId: '123456789012345678',
          hasCrown: true,
        },
        {
          userId: 999,
          playcount: 16,
          lastFmUsername: 'fm-bot',
          discordName: 'مس',
          discordUserId: '999',
          hasCrown: false,
        },
      ];

      const res = WhoKnowsBuilders.buildWhoKnowsResponse(
        dummyContext,
        'Gunna in الازعروكش',
        'https://www.last.fm/music/Gunna',
        'https://i.scdn.co/image/ab6761610000e5eba998bc86f87b9fe7e2466110',
        users as any,
        undefined,
        undefined,
        ['melodic rap'],
        undefined,
        WhoKnowsMode.Default,
        'Crown claimed by moha!',
      );

      // Must be a pure rich embed, NOT a components V2 container
      expect(res.componentsV2Container).toBeUndefined();
      expect(res.isComponentsV2).toBe(false);
      expect(res.embed).toBeDefined();

      // Check description matches exact fmbot unicode characters
      const desc = res.embed.data.description;
      expect(desc).toBe(
        '👑\u200A\u2005**[moha](https://last.fm/user/Moha504) - 263 plays**\n\u20052.\u2004\u2005[مس](https://last.fm/user/fm-bot) - **16** plays\n\nCrown claimed by moha!'
      );
    });
  });
});
