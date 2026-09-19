import { readFileSync } from 'fs';
import path from 'path';
import type { WhoKnowsUser } from '@bot/models/whoKnowsModels';
import { PuppeteerService } from './puppeteerService';

export interface WhoKnowsStatItem {
  value: string | number;
  label: string;
}

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
  tags?: string[];
  globalPlays?: number;
  globalListeners?: number;
  topItemLabel?: string;
  topItemValue?: string;
  topItemExtra?: string;
  topTracks?: string[];
  topListHeader?: string;
  stats?: WhoKnowsStatItem[];
  footerItemLabel?: string;
}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const formatCompact = (num: number): string => {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return num.toLocaleString();
};

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
    const userCount = Math.min(params.users?.length ?? 10, 10);
    let height = 860;
    if (userCount >= 8 || params.stats || params.topTracks) {
      height = 920;
    }
    if (params.crownText) {
      height += 60;
    }
    const callerInTop10 = (params.users ?? []).slice(0, 10).some(
      (u) =>
        (params.callerUserId && u.userId === params.callerUserId) ||
        (params.callerDiscordId && u.discordUserId === params.callerDiscordId),
    );
    if (!callerInTop10 && (params.callerUserId || params.callerDiscordId)) {
      height += 65;
    }

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
      tags,
      globalPlays,
      globalListeners,
      topItemLabel,
      topItemValue,
      topItemExtra,
      topTracks,
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
        if (user.hasCrown) {
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
    const cleanCrownText = crownText ? crownText.replace(/^👑\s*/, '') : '';
    const crownHtml = cleanCrownText
      ? `<div class="crown-banner"><span class="crown-banner-icon">👑</span><span>${escapeHtml(cleanCrownText)}</span></div>`
      : '';

    // Stats Bar: omit average if only one listener is on the table
    const listenersLabel = params.footerItemLabel || (totalListeners === 1 ? 'listener' : 'listeners');
    const playsLabel = totalPlays === 1 ? 'play' : 'total plays';
    let statsBarHtml = `<span><strong class="stat-highlight">${totalListeners.toLocaleString()}</strong> ${listenersLabel}</span>
      <span class="stat-sep">·</span>
      <span><strong class="stat-highlight">${totalPlays.toLocaleString()}</strong> ${playsLabel}</span>`;
    if (totalListeners > 1) {
      statsBarHtml += `
      <span class="stat-sep">·</span>
      <span><strong class="stat-highlight">${avgPlays.toLocaleString()}</strong> avg</span>`;
    }

    // Dynamic Album Covers Mosaic Wallpaper
    const fallbackImage =
      imageUrl ||
      'https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png';
    const covers =
      backgroundCovers && backgroundCovers.length > 0
        ? backgroundCovers
        : [fallbackImage];

    const TOTAL_TILES = 10; // 5 columns x 2 rows = 10 large tiles
    const mosaicTilesHtml = Array.from({ length: TOTAL_TILES }, (_, idx) => {
      const url = covers[idx % covers.length] ?? fallbackImage;
      return `<div class="mosaic-tile"><img class="mosaic-tile-img" src="${escapeHtml(url)}" alt="Album" onerror="this.style.display='none';"></div>`;
    }).join('\n');

    // Artwork Meta Section (Tags, Global Stats, Top Item)
    const tagPills = (tags && tags.length > 0)
      ? tags.slice(0, 4).map((t) => `<span class="genre-tag"><span class="genre-tag-dot">✦</span>${escapeHtml(t)}</span>`).join('')
      : '';

    let infoBoxHtml = '';
    const hasCustomStats = Boolean(params.stats && params.stats.length > 0);
    const hasGlobal = globalPlays !== undefined || globalListeners !== undefined;
    const hasTopList = Boolean(topTracks && topTracks.length > 0);
    const hasTop = Boolean(topItemLabel && topItemValue);

    if (hasCustomStats || hasGlobal || hasTopList || hasTop) {
      let statsRow = '';
      if (hasCustomStats) {
        statsRow = `
          <div class="info-row-stats">
            ${params.stats!.map((s, idx) => `
              <div class="info-stat-item">
                <span class="info-stat-num">${typeof s.value === 'number' ? formatCompact(s.value) : escapeHtml(String(s.value))}</span>
                <span class="info-stat-lbl">${escapeHtml(s.label)}</span>
              </div>
              ${idx < params.stats!.length - 1 ? '<div class="info-stat-divider"></div>' : ''}
            `).join('')}
          </div>`;
      } else if (hasGlobal) {
        const playsFormatted = globalPlays !== undefined ? formatCompact(globalPlays) : null;
        const listenersFormatted = globalListeners !== undefined ? formatCompact(globalListeners) : null;
        statsRow = `
          <div class="info-row-stats">
            ${playsFormatted ? `
              <div class="info-stat-item">
                <span class="info-stat-num">${playsFormatted}</span>
                <span class="info-stat-lbl">scrobbles</span>
              </div>` : ''}
            ${playsFormatted && listenersFormatted ? '<div class="info-stat-divider"></div>' : ''}
            ${listenersFormatted ? `
              <div class="info-stat-item">
                <span class="info-stat-num">${listenersFormatted}</span>
                <span class="info-stat-lbl">listeners</span>
              </div>` : ''}
          </div>`;
      }

      let topRow = '';
      if (hasTopList) {
        const tracksToRender = topTracks!.slice(0, 3);
        const headerTitle = params.topListHeader || 'Top Tracks';
        topRow = `
          <div class="info-top-list">
            <div class="info-top-header">${escapeHtml(headerTitle)}</div>
            ${tracksToRender.map((t, idx) => `
              <div class="info-top-item">
                <span class="info-top-rank">${idx + 1}</span>
                <span class="info-top-name">${escapeHtml(t)}</span>
              </div>
            `).join('')}
          </div>`;
      } else if (hasTop && topItemLabel && topItemValue) {
        topRow = `
          <div class="info-row-top">
            <span class="info-top-badge">${escapeHtml(topItemLabel)}</span>
            <span class="info-top-val" title="${escapeHtml(topItemValue)}">${escapeHtml(topItemValue)}${topItemExtra ? ` <span class="info-top-extra">(${escapeHtml(topItemExtra)})</span>` : ''}</span>
          </div>`;
      }

      infoBoxHtml = `
        <div class="info-card">
          ${statsRow}
          ${topRow}
        </div>`;
    }

    const artworkMetaHtml = (tagPills || infoBoxHtml)
      ? `<div class="artwork-meta">
          ${tagPills ? `<div class="genre-tags">${tagPills}</div>` : ''}
          ${infoBoxHtml}
        </div>`
      : '';

    // Token Replacements (use replacer functions to prevent $ from triggering RegExp substitution patterns)
    let output = template;
    output = output.replace(/\{\{type\}\}/g, () => escapeHtml(type));
    output = output.replace(/\{\{title\}\}/g, () => escapeHtml(title));
    output = output.replace(/\{\{location\}\}/g, () => escapeHtml(location));
    output = output.replace(
      /\{\{image-url\}\}/g,
      () => escapeHtml(
        imageUrl ||
          'https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png',
      ),
    );
    output = output.replace(
      /\{\{hide-img\}\}/g,
      () => (imageUrl ? '' : 'hidden'),
    );
    output = output.replace(/\{\{artwork-meta\}\}/g, () => artworkMetaHtml);
    output = output.replace(/\{\{users\}\}/g, () => userRowsHtml || '<li class="user-row"><div class="name-col">No listeners found</div></li>');
    output = output.replace(/\{\{caller-html\}\}/g, () => callerHtml);
    output = output.replace(/\{\{mosaic-tiles\}\}/g, () => mosaicTilesHtml);
    output = output.replace(/\{\{stats-bar\}\}/g, () => statsBarHtml);
    output = output.replace(/\{\{listeners\}\}/g, () => totalListeners.toLocaleString());
    output = output.replace(/\{\{plays\}\}/g, () => totalPlays.toLocaleString());
    output = output.replace(/\{\{average\}\}/g, () => avgPlays.toLocaleString());
    output = output.replace(/\{\{crown-html\}\}/g, () => crownHtml);

    return output;
  }
}
