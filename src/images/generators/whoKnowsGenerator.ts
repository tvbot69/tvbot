import { readFileSync } from 'fs';
import path from 'path';
import type { WhoKnowsUser } from '@bot/models/whoKnowsModels';
import { PuppeteerService } from './puppeteerService';

export interface WhoKnowsImageParams {
  type: string;
  title: string;
  location: string;
  imageUrl?: string;
  users: WhoKnowsUser[];
  callerUserId?: number;
  callerDiscordId?: string;
  crownText?: string;
  backgroundCovers?: string[];
}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export class WhoKnowsGenerator {
  private readonly puppeteer: PuppeteerService;
  private templateCache: string | null = null;

  constructor(puppeteer: PuppeteerService) {
    this.puppeteer = puppeteer;
  }

  private getTemplate(): string {
    if (!this.templateCache) {
      const templatePath = path.resolve(__dirname, '../pages/whoknows.html');
      this.templateCache = readFileSync(templatePath, 'utf-8');
    }
    return this.templateCache;
  }

  public async generateWhoKnowsImage(params: WhoKnowsImageParams): Promise<Buffer> {
    const template = this.getTemplate();
    const html = this.buildHtml(template, params);

    const width = 1200;
    const height = params.crownText ? 870 : 800;

    return this.puppeteer.screenshotHtml(html, width, height);
  }

  private buildHtml(template: string, params: WhoKnowsImageParams): string {
    const {
      type,
      title,
      location,
      imageUrl,
      users,
      callerUserId,
      callerDiscordId,
      crownText,
      backgroundCovers,
    } = params;

    const getPlays = (u: WhoKnowsUser): number =>
      u.playcount ?? (u as any).plays ?? 0;

    const distinctUsers = users.filter(
      (u, i, arr) => arr.findIndex((x) => x.userId === u.userId) === i,
    );
    const sortedUsers = [...distinctUsers].sort((a, b) => getPlays(b) - getPlays(a));

    const totalListeners = sortedUsers.filter((u) => getPlays(u) > 0).length;
    const totalPlays = sortedUsers.reduce((sum, u) => sum + getPlays(u), 0);
    const avgPlays = totalListeners > 0 ? Math.round(totalPlays / totalListeners) : 0;

    const top10 = sortedUsers.slice(0, 10);
    let callerInTop10 = false;

    const userRowsHtml = top10
      .map((user, idx) => {
        const rank = idx + 1;
        const isCaller =
          (callerUserId && user.userId === callerUserId) ||
          (callerDiscordId && user.discordUserId === callerDiscordId);

        if (isCaller) callerInTop10 = true;

        let rankHtml: string;
        if (user.hasCrown || (rank === 1 && !crownText)) {
          rankHtml = '<span class="rank-crown">👑</span>';
        } else if (rank === 1) {
          rankHtml = '<span class="rank-gold">1.</span>';
        } else if (rank === 2) {
          rankHtml = '<span class="rank-silver">2.</span>';
        } else if (rank === 3) {
          rankHtml = '<span class="rank-bronze">3.</span>';
        } else {
          rankHtml = `<span>${rank}.</span>`;
        }

        const name =
          user.discordName ||
          user.lastFmUsername ||
          (user as any).userName ||
          'Unknown';
        const playcount = user.playcount ?? (user as any).plays ?? 0;
        const playsFormatted = playcount.toLocaleString();
        const highlightClass = isCaller ? 'caller-highlight' : '';

        return `
          <li class="user-row ${highlightClass}">
            <div class="rank-col">${rankHtml}</div>
            <div class="name-col">${escapeHtml(name)}</div>
            <div class="plays-col">${playsFormatted}<span class="plays-unit">plays</span></div>
          </li>`;
      })
      .join('');

    // Check if caller exists and is outside top 10
    let callerHtml = '';
    if (!callerInTop10) {
      const callerIndex = sortedUsers.findIndex(
        (u) =>
          (callerUserId && u.userId === callerUserId) ||
          (callerDiscordId && u.discordUserId === callerDiscordId),
      );

      if (callerIndex !== -1) {
        const callerUser = sortedUsers[callerIndex]!;
        const callerRank = callerIndex + 1;
        const callerName =
          callerUser.discordName ||
          callerUser.lastFmUsername ||
          (callerUser as any).userName ||
          'You';
        const callerPlays = (
          callerUser.playcount ??
          (callerUser as any).plays ??
          0
        ).toLocaleString();

        callerHtml = `
          <div class="caller-outside-container">
            <div class="user-row caller-highlight">
              <div class="rank-col">#${callerRank}</div>
              <div class="name-col">${escapeHtml(callerName)}</div>
              <div class="plays-col">${callerPlays}<span class="plays-unit">plays</span></div>
            </div>
          </div>`;
      }
    }

    // Crown Ribbon
    const crownHtml = crownText
      ? `<div class="crown-banner"><span class="crown-banner-icon">👑</span><span>${escapeHtml(crownText)}</span></div>`
      : '';

    // Dynamic Album Covers Mosaic Wallpaper
    const fallbackImage =
      imageUrl ||
      'https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png';
    const covers =
      backgroundCovers && backgroundCovers.length > 0
        ? backgroundCovers
        : [fallbackImage];

    const TOTAL_TILES = 21; // 7 columns x 3 rows = 21
    const mosaicTilesHtml = Array.from({ length: TOTAL_TILES }, (_, idx) => {
      const url = covers[idx % covers.length] ?? fallbackImage;
      return `<div class="mosaic-tile"><img class="mosaic-tile-img" src="${escapeHtml(url)}" alt="Album" onerror="this.style.display='none';"></div>`;
    }).join('\n');

    // Token Replacements
    let output = template;
    output = output.replace(/\{\{type\}\}/g, escapeHtml(type));
    output = output.replace(/\{\{title\}\}/g, escapeHtml(title));
    output = output.replace(/\{\{location\}\}/g, escapeHtml(location));
    output = output.replace(
      /\{\{image-url\}\}/g,
      escapeHtml(
        imageUrl ||
          'https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png',
      ),
    );
    output = output.replace(
      /\{\{hide-img\}\}/g,
      imageUrl ? '' : 'hidden',
    );
    output = output.replace(/\{\{users\}\}/g, userRowsHtml || '<li class="user-row"><div class="name-col">No listeners found</div></li>');
    output = output.replace(/\{\{caller-html\}\}/g, callerHtml);
    output = output.replace(/\{\{mosaic-tiles\}\}/g, mosaicTilesHtml);
    output = output.replace(/\{\{listeners\}\}/g, totalListeners.toLocaleString());
    output = output.replace(/\{\{plays\}\}/g, totalPlays.toLocaleString());
    output = output.replace(/\{\{average\}\}/g, avgPlays.toLocaleString());
    output = output.replace(/\{\{crown-html\}\}/g, crownHtml);

    return output;
  }
}
