import { injectable, inject } from 'tsyringe';
import { PuppeteerService } from './puppeteerService';
import type { IcebergData } from '@bot/services/musicIntelligenceService';

@injectable()
export class IcebergGenerator {
  constructor(
    @inject(PuppeteerService) private readonly puppeteerService: PuppeteerService,
  ) {}

  private escapeHtml(str: string): string {
    return (str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  public async generateIceberg(data: IcebergData): Promise<Buffer> {
    const tierMeta = [
      { depth: "SURFACE LEVEL", width: 440, chipClass: "chip-tip" },
      { depth: "-100m", width: 560, chipClass: "chip-surface" },
      { depth: "-500m", width: 680, chipClass: "chip-shallow" },
      { depth: "-1,500m", width: 780, chipClass: "chip-deep" },
      { depth: "-3,500m", width: 720, chipClass: "chip-twilight" },
      { depth: "-6,500m", width: 620, chipClass: "chip-abyss" },
      { depth: "-11,000m", width: 500, chipClass: "chip-trench" },
    ];

    let tiersHtml = '';
    data.tiers.forEach((tier, idx) => {
      const meta = tierMeta[idx] ?? tierMeta[tierMeta.length - 1]!;
      const artists = tier.artists.slice(0, 16);
      let chips = artists
        .map((a) => `<span class="artist-chip ${meta.chipClass}">${this.escapeHtml(a.name)}</span>`)
        .join('');
      if (tier.artists.length > 16) {
        chips += `<span class="artist-chip more-chip">+${tier.artists.length - 16} more</span>`;
      }
      if (artists.length === 0) {
        chips = `<span class="empty-chip">No artists in this tier</span>`;
      }

      tiersHtml += `
        <div class="tier-row" style="width: ${meta.width}px;">
          <div class="tier-header">
            <span class="tier-tag">L${tier.tierNumber} • ${this.escapeHtml(tier.name).toUpperCase()}</span>
            <span class="tier-depth">${meta.depth}</span>
          </div>
          <div class="tier-chips">
            ${chips}
          </div>
        </div>
      `;
    });

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: 920px;
    height: 1320px;
    background: #020b14;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #fff;
    overflow: hidden;
    position: relative;
  }

  /* Atmospheric Background */
  .sky-layer {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 280px;
    background: linear-gradient(180deg, #18334f 0%, #224d77 25%, #3e7fb5 60%, #7ec2f0 90%, #b8e2fb 100%);
  }
  .sun-glow {
    position: absolute;
    top: 60px;
    left: 50%;
    transform: translateX(-50%);
    width: 500px;
    height: 220px;
    background: radial-gradient(ellipse at center, rgba(255, 255, 255, 0.6) 0%, rgba(224, 242, 254, 0.25) 45%, rgba(255, 255, 255, 0) 75%);
    pointer-events: none;
  }
  .ocean-layer {
    position: absolute;
    top: 280px;
    left: 0;
    width: 100%;
    height: 1040px;
    background: linear-gradient(180deg, 
      #0284c7 0%, 
      #0369a1 8%, 
      #075985 20%, 
      #0c4a6e 35%, 
      #083344 52%, 
      #062333 70%, 
      #031420 85%, 
      #010910 100%);
  }

  /* Sun rays streaming through water */
  .light-shafts {
    position: absolute;
    top: 280px;
    left: 0;
    width: 100%;
    height: 420px;
    background: repeating-linear-gradient(
      115deg,
      rgba(255, 255, 255, 0.12) 0px,
      rgba(255, 255, 255, 0.12) 35px,
      transparent 35px,
      transparent 80px,
      rgba(255, 255, 255, 0.08) 80px,
      rgba(255, 255, 255, 0.08) 130px,
      transparent 130px,
      transparent 200px
    );
    mask-image: linear-gradient(180deg, rgba(0,0,0,1) 0%, rgba(0,0,0,0) 100%);
    -webkit-mask-image: linear-gradient(180deg, rgba(0,0,0,1) 0%, rgba(0,0,0,0) 100%);
    pointer-events: none;
  }

  /* Waterline / Sea Level */
  .waterline-container {
    position: absolute;
    top: 270px;
    left: 0;
    width: 100%;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10;
  }
  .sea-level-badge {
    position: relative;
    z-index: 12;
    background: rgba(8, 47, 73, 0.92);
    border: 1.5px solid #38bdf8;
    color: #f0f9ff;
    font-size: 11px;
    font-weight: 900;
    letter-spacing: 2.5px;
    padding: 3px 20px;
    border-radius: 9999px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5), 0 0 16px rgba(56, 189, 248, 0.5);
  }

  /* The Glacial Iceberg Illustration SVG in Background */
  .iceberg-svg-bg {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    z-index: 2;
    pointer-events: none;
  }

  /* Content Wrapper */
  .content-wrapper {
    position: relative;
    z-index: 5;
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: 18px 24px 16px;
  }

  /* Header */
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: rgba(8, 28, 48, 0.65);
    backdrop-filter: blur(14px);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 16px;
    padding: 12px 22px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    margin-bottom: 8px;
  }
  .header-left {
    display: flex;
    flex-direction: column;
  }
  .header-title {
    font-size: 20px;
    font-weight: 900;
    letter-spacing: 0.5px;
    color: #ffffff;
    display: flex;
    align-items: center;
    gap: 8px;
    text-shadow: 0 2px 8px rgba(0,0,0,0.5);
  }
  .header-subtitle {
    font-size: 12.5px;
    color: #93c5fd;
    font-weight: 500;
    margin-top: 2px;
  }
  .header-badge {
    background: linear-gradient(135deg, #0284c7 0%, #0369a1 100%);
    border: 1px solid #38bdf8;
    color: #ffffff;
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 1px;
    padding: 5px 12px;
    border-radius: 20px;
    box-shadow: 0 2px 8px rgba(2, 132, 199, 0.4);
  }

  /* Depth Gauge Ruler on Left */
  .depth-ruler {
    position: absolute;
    left: 20px;
    top: 295px;
    bottom: 50px;
    width: 45px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    font-size: 10px;
    font-weight: 700;
    color: rgba(186, 230, 253, 0.55);
    border-left: 1px dashed rgba(186, 230, 253, 0.35);
    padding-left: 8px;
    z-index: 4;
    pointer-events: none;
  }

  /* Tiers Container */
  .tiers-container {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-around;
    padding: 4px 0;
  }

  .tier-row {
    display: flex;
    flex-direction: column;
    align-items: center;
    position: relative;
    padding: 6px 12px;
    border-radius: 14px;
    background: rgba(12, 38, 64, 0.35);
    backdrop-filter: blur(8px);
    border: 1px solid rgba(255, 255, 255, 0.12);
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.25);
  }

  .tier-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    margin-bottom: 6px;
    padding: 0 4px;
  }
  .tier-tag {
    font-size: 10.5px;
    font-weight: 800;
    letter-spacing: 1.5px;
    color: #bae6fd;
    text-shadow: 0 1px 3px rgba(0,0,0,0.6);
  }
  .tier-depth {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 1px;
    color: rgba(224, 242, 254, 0.7);
  }

  .tier-chips {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    align-items: center;
    gap: 6px;
    width: 100%;
  }

  .artist-chip {
    font-size: 12px;
    font-weight: 700;
    padding: 4px 10px;
    border-radius: 9999px;
    white-space: nowrap;
    line-height: 1.25;
  }

  /* Specific Chip Stylings per Depth Tier */
  .chip-tip {
    background: #ffffff;
    color: #0c4a6e;
    border: 1px solid #e0f2fe;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
    font-size: 12.5px;
  }
  .chip-surface {
    background: rgba(255, 255, 255, 0.25);
    color: #ffffff;
    border: 1px solid rgba(255, 255, 255, 0.5);
    text-shadow: 0 1px 3px rgba(0,0,0,0.5);
  }
  .chip-shallow {
    background: rgba(56, 189, 248, 0.22);
    color: #f0f9ff;
    border: 1px solid rgba(125, 211, 252, 0.4);
    text-shadow: 0 1px 3px rgba(0,0,0,0.6);
  }
  .chip-deep {
    background: rgba(14, 165, 233, 0.18);
    color: #e0f2fe;
    border: 1px solid rgba(56, 189, 248, 0.35);
    text-shadow: 0 1px 3px rgba(0,0,0,0.6);
  }
  .chip-twilight {
    background: rgba(3, 105, 161, 0.25);
    color: #bae6fd;
    border: 1px solid rgba(56, 189, 248, 0.25);
    text-shadow: 0 1px 3px rgba(0,0,0,0.7);
  }
  .chip-abyss {
    background: rgba(8, 47, 73, 0.45);
    color: #7dd3fc;
    border: 1px solid rgba(14, 165, 233, 0.3);
    text-shadow: 0 1px 4px rgba(0,0,0,0.8);
  }
  .chip-trench {
    background: rgba(2, 20, 36, 0.7);
    color: #38bdf8;
    border: 1px solid rgba(56, 189, 248, 0.45);
    text-shadow: 0 0 6px rgba(56, 189, 248, 0.4);
  }
  .more-chip {
    background: rgba(0, 0, 0, 0.45);
    color: rgba(255, 255, 255, 0.7);
    border: 1px dashed rgba(255, 255, 255, 0.25);
    font-size: 11px;
    font-style: italic;
  }
  .empty-chip {
    font-size: 11.5px;
    font-style: italic;
    color: rgba(255, 255, 255, 0.5);
  }

  /* Footer */
  .footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 12px 0;
    font-size: 11px;
    font-weight: 600;
    color: rgba(147, 197, 253, 0.6);
    letter-spacing: 0.5px;
  }
</style>
</head>
<body>
  <!-- Sky & Water Background Layers -->
  <div class="sky-layer">
    <div class="sun-glow"></div>
  </div>
  <div class="ocean-layer">
    <div class="light-shafts"></div>
  </div>

  <!-- Waterline / Sea Level -->
  <div class="waterline-container">
    <div class="sea-level-badge">SEA LEVEL • 0m</div>
  </div>

  <!-- Depth Gauge Ruler -->
  <div class="depth-ruler">
    <span>-200m</span>
    <span>-800m</span>
    <span>-2,000m</span>
    <span>-4,500m</span>
    <span>-7,500m</span>
    <span>-11,000m</span>
  </div>

  <!-- SVG Iceberg Mountain in Center -->
  <svg class="iceberg-svg-bg" viewBox="0 0 920 1320" fill="none" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <!-- Above water tip gradients -->
      <linearGradient id="tip-lit" x1="460" y1="90" x2="380" y2="280" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#ffffff" />
        <stop offset="60%" stop-color="#f8fafc" />
        <stop offset="100%" stop-color="#e0f2fe" />
      </linearGradient>
      <linearGradient id="tip-shaded" x1="460" y1="90" x2="540" y2="280" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#e0f2fe" />
        <stop offset="60%" stop-color="#bae6fd" />
        <stop offset="100%" stop-color="#7dd3fc" />
      </linearGradient>
      
      <!-- Underwater glacier mass gradients (Vibrant Glacial Cyan) -->
      <linearGradient id="underwater-ice-body" x1="460" y1="280" x2="460" y2="1270" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="rgba(186, 230, 253, 0.75)" />
        <stop offset="15%" stop-color="rgba(56, 189, 248, 0.65)" />
        <stop offset="40%" stop-color="rgba(14, 165, 233, 0.52)" />
        <stop offset="65%" stop-color="rgba(2, 132, 199, 0.42)" />
        <stop offset="85%" stop-color="rgba(3, 105, 161, 0.35)" />
        <stop offset="100%" stop-color="rgba(8, 47, 73, 0.45)" />
      </linearGradient>

      <!-- Shaded underwater facets -->
      <linearGradient id="facet-dark" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="rgba(2, 132, 199, 0.25)" />
        <stop offset="100%" stop-color="rgba(3, 105, 161, 0.55)" />
      </linearGradient>
      <linearGradient id="facet-bright" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="rgba(255, 255, 255, 0.4)" />
        <stop offset="100%" stop-color="rgba(56, 189, 248, 0.25)" />
      </linearGradient>
    </defs>

    <!-- Water Surface Wave Line across Canvas -->
    <path d="M0,280 Q75,274 150,280 T300,280 T450,280 T600,280 T750,280 T920,280" stroke="rgba(255, 255, 255, 0.9)" stroke-width="3" fill="none" filter="drop-shadow(0 0 8px #38bdf8)" />

    <!-- ABOVE WATER ICEBERG (THE TIP) -->
    <!-- Left snowy facet -->
    <polygon points="460,85 375,278 460,278" fill="url(#tip-lit)" />
    <!-- Left outer crag -->
    <polygon points="460,85 410,170 355,278 375,278" fill="#ffffff" opacity="0.9" />
    <!-- Right shadowed facet -->
    <polygon points="460,85 460,278 545,278" fill="url(#tip-shaded)" />
    <!-- Right outer crag -->
    <polygon points="460,85 495,160 565,278 545,278" fill="#93c5fd" opacity="0.75" />
    <!-- Snow peak highlight -->
    <polyline points="410,170 460,85 495,160" stroke="#ffffff" stroke-width="3.5" stroke-linecap="round" />

    <!-- UNDERWATER GLACIAL BODY -->
    <!-- Main massive underwater polygon -->
    <polygon points="
      355,280 
      230,390 
      140,570 
      115,760 
      165,970 
      280,1140 
      460,1270 
      640,1140 
      755,970 
      805,760 
      780,570 
      690,390 
      565,280
    " fill="url(#underwater-ice-body)" stroke="rgba(255,255,255,0.4)" stroke-width="2.5" filter="drop-shadow(0 0 25px rgba(56, 189, 248, 0.35))" />

    <!-- Glacial Internal Crystalline Facets (Adds true 3D crystal depth) -->
    <polygon points="355,280 460,450 230,390" fill="url(#facet-bright)" stroke="rgba(255,255,255,0.2)" />
    <polygon points="565,280 460,450 690,390" fill="url(#facet-dark)" stroke="rgba(255,255,255,0.18)" />
    <polygon points="460,450 230,390 140,570 460,630" fill="url(#facet-bright)" stroke="rgba(255,255,255,0.16)" />
    <polygon points="460,450 690,390 780,570 460,630" fill="url(#facet-dark)" stroke="rgba(255,255,255,0.16)" />
    <polygon points="460,630 140,570 115,760 460,820" fill="url(#facet-bright)" stroke="rgba(255,255,255,0.14)" />
    <polygon points="460,630 780,570 805,760 460,820" fill="url(#facet-dark)" stroke="rgba(255,255,255,0.14)" />
    <polygon points="460,820 115,760 165,970 460,1010" fill="url(#facet-bright)" stroke="rgba(255,255,255,0.12)" />
    <polygon points="460,820 805,760 755,970 460,1010" fill="url(#facet-dark)" stroke="rgba(255,255,255,0.12)" />
    <polygon points="460,1010 165,970 280,1140 460,1185" fill="url(#facet-bright)" stroke="rgba(255,255,255,0.1)" />
    <polygon points="460,1010 755,970 640,1140 460,1185" fill="url(#facet-dark)" stroke="rgba(255,255,255,0.1)" />
    <polygon points="460,1185 280,1140 460,1270" fill="url(#facet-bright)" stroke="rgba(255,255,255,0.08)" />
    <polygon points="460,1185 640,1140 460,1270" fill="url(#facet-dark)" stroke="rgba(255,255,255,0.08)" />

    <!-- Icy Ridge Spine Center Line -->
    <polyline points="460,85 460,280 460,450 460,630 460,820 460,1010 460,1185 460,1270" stroke="rgba(255,255,255,0.45)" stroke-width="2.5" stroke-dasharray="6 3" />
  </svg>

  <!-- Content (Header, Tiers, Footer) -->
  <div class="content-wrapper">
    <div class="header">
      <div class="header-left">
        <div class="header-title">
          <span>🧊</span>
          <span>${this.escapeHtml(data.displayName.toUpperCase())}'S MUSIC ICEBERG</span>
        </div>
        <div class="header-subtitle">
          ${this.escapeHtml(data.timePeriodDescription)} • ${data.totalArtists} top artists analyzed
        </div>
      </div>
      <div class="header-badge">tvbot.fm</div>
    </div>

    <div class="tiers-container">
      ${tiersHtml}
    </div>

    <div class="footer">
      <span>tvbot music intelligence • Depth: 11,000m</span>
      <span>last.fm/user/${this.escapeHtml(data.userNameLastFm)}</span>
    </div>
  </div>
</body>
</html>`;

    return await this.puppeteerService.screenshotHtml(html, 920, 1320);
  }
}
