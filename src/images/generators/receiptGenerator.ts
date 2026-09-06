import { injectable, inject } from 'tsyringe';
import fs from 'fs';
import path from 'path';
import { PuppeteerService } from './puppeteerService';

export interface ReceiptTrackItem {
  artistName: string;
  trackName: string;
  userPlaycount: number;
}

export interface ReceiptData {
  userNameLastFm: string;
  displayName: string;
  periodDescription: string;
  tracks: ReceiptTrackItem[];
  totalPlays: number;
  totalTracks?: number;
  orderNumber?: number;
  authCode?: string;
  year?: number;
}

@injectable()
export class ReceiptGenerator {
  private receiptHtmlTemplate: string = '';

  constructor(
    @inject(PuppeteerService) private readonly puppeteerService: PuppeteerService,
  ) {
    const candidatePaths = [
      path.join(__dirname, '..', 'pages', 'receipt.html'),
      path.join(process.cwd(), 'src', 'images', 'pages', 'receipt.html'),
      path.join(process.cwd(), 'dist', 'images', 'pages', 'receipt.html'),
    ];

    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        this.receiptHtmlTemplate = fs.readFileSync(p, 'utf8');
        break;
      }
    }
  }

  private escapeHtml(str: string): string {
    return (str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  public async generateReceipt(data: ReceiptData): Promise<Buffer> {
    let template = this.receiptHtmlTemplate;
    if (!template) {
      throw new Error('receipt.html template not found');
    }

    const maxTracks = data.tracks.slice(0, 12);
    let tracksHtml = '';
    let subtotal = 0;

    for (const t of maxTracks) {
      subtotal += t.userPlaycount;
      const safeArtist = this.escapeHtml(t.artistName);
      const safeTrack = this.escapeHtml(t.trackName);
      tracksHtml += `<tr>
        <td>${safeArtist} - ${safeTrack}</td>
        <td class="align-right">${t.userPlaycount.toLocaleString()}</td>
      </tr>`;
    }

    const order = data.orderNumber ?? Math.floor(Math.random() * 9000) + 1000;
    const now = new Date();
    const dateGenerated = now.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    const totalTracksHtml = data.totalTracks && data.totalTracks > 0
      ? `<tr>
          <td class="min-width"></td>
          <td>TOTAL TRACKS:</td>
          <td class="align-right">${data.totalTracks.toLocaleString()}</td>
        </tr>`
      : '';

    const bgOffset = Math.floor(Math.random() * 990) + 10;
    const yearStr = (data.year ?? now.getFullYear()).toString();
    const authCodeStr = data.authCode ?? Math.floor(Math.random() * 900000 + 100000).toString();

    template = template
      .replace('{{tracks}}', tracksHtml)
      .replace('{{subtotal}}', subtotal.toLocaleString())
      .replace('{{total-plays}}', data.totalPlays.toLocaleString())
      .replace('{{total-tracks}}', totalTracksHtml)
      .replace('{{order}}', order.toString())
      .replace('{{time-period}}', this.escapeHtml(data.periodDescription.toUpperCase()))
      .replace('{{date-generated}}', dateGenerated)
      .replace('{{lfm-username}}', this.escapeHtml(data.userNameLastFm))
      .replace('{{discord-username}}', this.escapeHtml(data.displayName))
      .replace('{{auth-code}}', authCodeStr)
      .replace('{{background-offset}}', bgOffset.toString())
      .replace('{{year}}', yearStr)
      .replace('{{thanks}}', 'Thank you for using tvbot - Enjoy the music!');

    // Add font fallback to ensure clean rendering even without internet font fetch
    template = template.replace(
      'font-family: "receipt";',
      'font-family: "receipt", "Courier New", Courier, monospace;',
    );

    const calculatedHeight = Math.max(680, 520 + maxTracks.length * 36);
    return await this.puppeteerService.screenshotHtml(template, 500, calculatedHeight);
  }
}
