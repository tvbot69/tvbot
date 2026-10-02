import { describe, it, expect } from 'vitest';
import {
  ComponentType,
  type APIActionRowComponent,
  type APIComponentInContainer,
  type APIComponentInMessageActionRow,
  type APISectionAccessoryComponent,
  type APISectionComponent,
  type APIStringSelectComponent,
  type APITextDisplayComponent,
} from 'discord.js';
import { UserSettingsBuilders } from '@bot/builders/user/userSettingsBuilders';
import { ContextModel } from '@bot/models/contextModel';
import { PrivacyLevel } from '@domain/enums/privacyLevel';
import type { User } from '@domain/interfaces/ports/iuserRepository';
import { UserType, DataSource } from '@persistence/models/user';
import { WhoKnowsMode } from '@domain/enums/whoKnowsMode';
import { ResponseMode } from '@domain/enums/responseMode';
import { CoverType } from '@domain/enums/coverType';

/*
 * These assertions are about the SHAPE of a serialised Components V2 container,
 * so the container is walked through the real discord-api-types union.
 * `ContainerBuilder.toJSON()` already returns `APIContainerComponent`; each
 * predicate below is the real `type` discriminant. A builder that swapped a
 * TextDisplay for a Section now fails to compile here instead of quietly reading
 * `.content` off whatever happened to land in that slot.
 */
const isTextDisplay = (c: APIComponentInContainer): c is APITextDisplayComponent =>
  c.type === ComponentType.TextDisplay;

const isActionRow = (
  c: APIComponentInContainer,
): c is APIActionRowComponent<APIComponentInMessageActionRow> =>
  c.type === ComponentType.ActionRow;

const isSection = (c: APIComponentInContainer): c is APISectionComponent =>
  c.type === ComponentType.Section;

const isStringSelect = (
  c: APIComponentInMessageActionRow,
): c is APIStringSelectComponent => c.type === ComponentType.StringSelect;

/**
 * `APIButtonComponent` is a three-way union discriminated by `style`, and only
 * the custom-id variant carries `custom_id` - a link button carries `url`
 * instead. `in` is that discriminant.
 */
const customIdOf = (
  c: APIComponentInMessageActionRow | APISectionAccessoryComponent,
): string | undefined => ('custom_id' in c ? c.custom_id : undefined);

describe('UserSettingsBuilders', () => {
  const mockUser: User = {
    userId: 42,
    discordUserId: '123456789012345678',
    userNameLastFm: 'MohaTest',
    registeredOn: new Date('2024-01-01'),
    userType: UserType.User,
    dataSource: DataSource.LastFm,
    privacyLevel: PrivacyLevel.Default,
    whoKnowsMode: WhoKnowsMode.Default,
    mode: ResponseMode.Embed,
    coverType: CoverType.Motion,
    timeZone: 'Europe/London',
  };

  const createMockContext = (isAdmin = false): ContextModel => {
    const ctx = new ContextModel();
    ctx.discordUserId = '123456789012345678';
    ctx.guildId = '987654321098765432';
    ctx.prefix = '.';
    ctx.accentColor = 0xffffff;
    Object.defineProperty(ctx, 'userIsGuildAdmin', {
      get: () => isAdmin,
      configurable: true,
    });
    Object.defineProperty(ctx, 'discordDisplayName', {
      get: () => 'Moha',
      configurable: true,
    });
    return ctx;
  };

  it('buildUserSettingsResponse generates central hub with select menu and profile info', () => {
    const ctx = createMockContext(false);
    const response = UserSettingsBuilders.buildUserSettingsResponse(ctx, mockUser, false, 'user');

    expect(response.isComponentsV2).toBe(true);
    expect(response.componentsV2Container).toBeDefined();

    const json = response.componentsV2Container!.toJSON();
    expect(json.components).toBeDefined();

    // Check header text
    const textComponents = json.components.filter(isTextDisplay);
    expect(textComponents.some((t) => t.content.includes('tvbot user settings'))).toBe(true);
    expect(textComponents.some((t) => t.content.includes('MohaTest'))).toBe(true);

    // Check select menu row
    const actionRows = json.components.filter(isActionRow);
    const selectMenu = actionRows[0]?.components.find(
      (comp): comp is APIStringSelectComponent =>
        isStringSelect(comp) && comp.custom_id === 'user-settings:select',
    );
    expect(selectMenu).toBeDefined();
    expect(selectMenu?.options.length).toBeGreaterThanOrEqual(8);
  });

  it('buildUserSettingsResponse includes tab row when user is server admin', () => {
    const ctx = createMockContext(true);
    const response = UserSettingsBuilders.buildUserSettingsResponse(ctx, mockUser, true, 'user');

    const json = response.componentsV2Container!.toJSON();
    const actionRows = json.components.filter(isActionRow);

    // Should have 2 action rows: 1 for select menu, 1 for tabs
    expect(actionRows.length).toBe(2);
    const tabRow = actionRows[1]?.components;
    expect(tabRow?.some((b) => customIdOf(b) === 'user-settings:tab:user')).toBe(true);
    expect(tabRow?.some((b) => customIdOf(b) === 'user-settings:tab:server')).toBe(true);
  });

  it('buildModePickResponse builds 3 mode buttons', () => {
    const ctx = createMockContext(false);
    const response = UserSettingsBuilders.buildModePickResponse(ctx);

    expect(response.isComponentsV2).toBe(true);
    const json = response.componentsV2Container!.toJSON();

    const sections = json.components.filter(isSection);
    expect(sections.length).toBe(3);

    const buttonIds = sections.map((s) => customIdOf(s.accessory));
    expect(buttonIds).toContain('user-settings:open:fmmode');
    expect(buttonIds).toContain('user-settings:open:responsemode');
    expect(buttonIds).toContain('user-settings:open:covermode');
  });

  it('buildResponseModeResponse builds WhoKnows and Top list mode menus', () => {
    const ctx = createMockContext(false);
    const response = UserSettingsBuilders.buildResponseModeResponse(ctx, mockUser);

    expect(response.isComponentsV2).toBe(true);
    const json = response.componentsV2Container!.toJSON();

    const actionRows = json.components.filter(isActionRow);
    expect(actionRows.length).toBe(2);

    const wkSelect = actionRows[0]?.components.find(
      (c): c is APIStringSelectComponent =>
        isStringSelect(c) && c.custom_id === 'user-settings:set:wkmode',
    );
    expect(wkSelect).toBeDefined();
    expect(wkSelect?.options.length).toBe(3);

    const topSelect = actionRows[1]?.components.find(
      (c): c is APIStringSelectComponent =>
        isStringSelect(c) && c.custom_id === 'user-settings:set:topmode',
    );
    expect(topSelect).toBeDefined();
    expect(topSelect?.options.length).toBe(2);
  });

  it('buildCoverModeResponse builds CoverType select menu', () => {
    const ctx = createMockContext(false);
    const response = UserSettingsBuilders.buildCoverModeResponse(ctx, mockUser);

    expect(response.isComponentsV2).toBe(true);
    const json = response.componentsV2Container!.toJSON();

    const actionRows = json.components.filter(isActionRow);
    const coverSelect = actionRows[0]?.components.find(
      (c): c is APIStringSelectComponent =>
        isStringSelect(c) && c.custom_id === 'user-settings:set:covertype',
    );
    expect(coverSelect).toBeDefined();
    expect(coverSelect?.options.length).toBe(2);
  });

  it('buildSelfBlockResponse renders blocked and unblocked messages properly', () => {
    const blockedRes = UserSettingsBuilders.buildSelfBlockResponse('Cool Server', true, '.');
    const unblockedRes = UserSettingsBuilders.buildSelfBlockResponse('Cool Server', false, '.');

    const blockedJson = blockedRes.componentsV2Container!.toJSON();
    const unblockedJson = unblockedRes.componentsV2Container!.toJSON();

    const blockedText = blockedJson.components.filter(isTextDisplay)[0]?.content;
    const unblockedText = unblockedJson.components.filter(isTextDisplay)[0]?.content;

    expect(blockedText).toContain('Selfblocked in Cool Server');
    expect(blockedText).toContain('.selfunblock');
    expect(unblockedText).toContain('Selfblock removed in Cool Server');
  });
});
