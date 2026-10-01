import { ContainerBuilder, SectionBuilder, TextDisplayBuilder, ThumbnailBuilder, SeparatorBuilder } from 'discord.js';

const container = new ContainerBuilder().setAccentColor(0x10b981);

// Header section with tournament logo
const headerSection = new SectionBuilder()
  .addTextDisplayComponents(new TextDisplayBuilder().setContent('### 🇩🇪 Bundesliga\n📅 **In +7 days** • `1 match`'))
  .setThumbnailAccessory(new ThumbnailBuilder({ media: { url: 'https://a.espncdn.com/i/leaguelogos/soccer/500/10.png' } }));

container.addSectionComponents(headerSection);
container.addSeparatorComponents(new SeparatorBuilder());

// Match section
const matchSection = new SectionBuilder()
  .addTextDisplayComponents(new TextDisplayBuilder().setContent('> ⏰ <t:1789151400:t>\n> **1. FC Union Berlin** vs **Schalke 04**\n> -# 🏟️ Stadion An der Alten Försterei'))
  .setThumbnailAccessory(new ThumbnailBuilder({ media: { url: 'https://a.espncdn.com/i/teamlogos/soccer/500/361.png' } }));

container.addSectionComponents(matchSection);

console.log('JSON structure:');
console.log(JSON.stringify(container.toJSON(), null, 2));
