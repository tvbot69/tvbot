import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { ReceiptBuilders } from './receiptBuilders';
import { CommandResponse } from '@domain/enums/commandResponse';

describe('ReceiptBuilders', () => {
  it('formats Components V2 response container with receipt.png attachment', () => {
    const dummyBuffer = Buffer.from('mock_receipt_image');
    const response = ReceiptBuilders.buildReceiptResponse({
      displayName: 'Alice',
      userNameLastFm: 'alice_fm',
      periodDescription: 'weekly',
      imageBuffer: dummyBuffer,
      accentColor: 0x57f287,
    });

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(response.isComponentsV2).toBe(true);
    expect(response.hasFile()).toBe(true);
    expect(response.fileName).toBe('receipt.png');
    expect(response.componentsV2Container).toBeDefined();
  });
});
