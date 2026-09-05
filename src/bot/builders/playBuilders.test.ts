import { describe, expect, it } from 'vitest';
import { PlayBuilders } from './playBuilders';
import { FmEmbedType } from '@domain/enums/fmEmbedType';
import { FmButton } from '@domain/enums/fmButton';
import { FmFooterOption } from '@domain/enums/fmFooterOption';
import type { ContextModel } from '@bot/models/contextModel';
import type { User } from '@domain/interfaces/iuserRepository';

const context = { accentColor: 0x123456 } as ContextModel;
const user = { userId: 1, userNameLastFm: 'tester' } as User;
const tracks = [
  { name: 'Current Song', artistName: 'Artist', albumName: 'Album', nowPlaying: false, timePlayed: new Date('2026-08-27T00:00:00Z') },
  { name: 'Previous Song', artistName: 'Artist', albumName: 'Album', nowPlaying: false },
];
const setting = {
  embedType: FmEmbedType.EmbedMini,
  footerOptions: BigInt(FmFooterOption.TotalScrobbles),
  buttons: BigInt(FmButton.LastFmTrackLink | FmButton.LastFmArtistLink),
  accentColor: null,
  customColor: null,
  smallTextType: null,
};

describe('PlayBuilders.buildFmResponse', () => {
  it('creates each Components V2 layout with the expected structure', () => {
    for (const embedType of [FmEmbedType.EmbedTiny, FmEmbedType.EmbedMini, FmEmbedType.EmbedFull]) {
      const response = PlayBuilders.buildFmResponse(context, user, tracks, { name: 'tester', playCount: 42 }, { fmSetting: { ...setting, embedType } });
      expect(response.isComponentsV2).toBe(true);
      const json = response.componentsV2Container!.toJSON();
      expect(json.components.length).toBeGreaterThanOrEqual(3);
      expect(JSON.stringify(json)).toContain('Current Song');
    }
  });

  it('uses text responses for every text layout', () => {
    for (const embedType of [FmEmbedType.TextOneLine, FmEmbedType.TextMini, FmEmbedType.TextFull]) {
      const response = PlayBuilders.buildFmResponse(context, user, tracks, { name: 'tester', playCount: 42 }, { fmSetting: { ...setting, embedType } });
      expect(response.isComponentsV2).toBe(false);
      expect(response.embed.toJSON().description).toContain('Current Song');
    }
  });

  it('builds the FM mode selector panel', () => {
    const response = PlayBuilders.buildFmModeResponse(setting);
    expect(response.isComponentsV2).toBe(true);
    expect(response.componentsV2Container!.toJSON().components).toHaveLength(6);
  });
});
