import { describe, it, expect } from 'vitest';
import { DiscogsAndImportBuilders } from '../discogsAndImportBuilders';
import { CommandResponse } from '@domain/enums/commandResponse';

describe('DiscogsAndImportBuilders', () => {

  it('builds import instructions response', () => {
    const response = DiscogsAndImportBuilders.buildImportInstructionsResponse({
      instructions: 'Upload your file',
    });

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(response.componentsV2Container).toBeDefined();
  });

  it('builds import summary response', () => {
    const response = DiscogsAndImportBuilders.buildImportSummaryResponse({
      displayName: 'Alice',
      summary: {
        totalScrobblesImported: 5000,
        newRowsInserted: 4800,
        uniqueArtistsCount: 250,
        dateRange: { from: new Date('2020-01-01'), to: new Date('2023-01-01') },
        topArtists: [{ name: 'Radiohead', count: 1200 }],
      },
    });

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(response.componentsV2Container).toBeDefined();
  });

  it('builds import modify response', () => {
    const successRes = DiscogsAndImportBuilders.buildImportModifyResponse({ success: true });
    expect(successRes.commandResponse).toBe(CommandResponse.Ok);

    const failRes = DiscogsAndImportBuilders.buildImportModifyResponse({ success: false });
    expect(failRes.commandResponse).toBe(CommandResponse.Ok);
  });
});
