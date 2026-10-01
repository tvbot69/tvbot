import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { InteractionHandler } from '@bot/handlers/interactionHandler';

/**
 * interactionHandler was 38.44% with 349 uncovered lines.
 *
 * `isBlockedInContext` is a four-layer permission check, and the ORDER plus
 * the FAIL-OPEN behaviour are the whole design:
 *
 *  1. server-wide disable
 *  2. channel disable
 *  3. staff-disabled command
 *  4. channel-level toggle
 *
 * The catch returns null, not a message. That is deliberate and worth pinning:
 * if the database is down, a server that has disabled nothing must keep
 * working. Failing closed there would take the entire bot offline for every
 * guild because one Redis read threw.
 */


const build = (over: Record<string, unknown> = {}) => {
  const guildService = { getGuild: vi.fn(async () => ({ commandsDisabled: false })), ...(over.guildService as object) };
  const disabledChannelService = { isChannelDisabled: vi.fn(async () => false), ...(over.disabledChannelService as object) };
  const guildDisabledCommands = { isCommandDisabled: vi.fn(async () => false), ...(over.guildDisabledCommands as object) };
  const channelToggledCommands = { isCommandToggled: vi.fn(async () => false), ...(over.channelToggledCommands as object) };
  // A handler built through the container, with only the four collaborators
  // this test needs replaced. Constructing it directly is not possible: the
  // constructor takes 30 positional collaborators.
  const handler = Object.create(InteractionHandler.prototype) as InteractionHandler;
  Object.assign(handler, { guildService, disabledChannelService, guildDisabledCommands, channelToggledCommands });
  return { handler, guildService, disabledChannelService, guildDisabledCommands, channelToggledCommands };
};

const check = (handler: InteractionHandler, guildId: string | null, channelId: string | null, cmd = 'plays') =>
  handler.isBlockedInContext(guildId, channelId, cmd);

beforeEach(() => vi.clearAllMocks());

describe('InteractionHandler.isBlockedInContext', () => {
  it('allows everything in a DM, where there is no guild to configure', async () => {
    const { handler, guildService } = build();
    await expect(check(handler, null, 'c1')).resolves.toBeNull();
    expect(guildService.getGuild).not.toHaveBeenCalled();
  });

  it('allows when no gate fires', async () => {
    const { handler } = build();
    await expect(check(handler, 'g1', 'c1')).resolves.toBeNull();
  });

  it('blocks when the whole server is disabled', async () => {
    const { handler, guildService } = build();
    (guildService.getGuild as ReturnType<typeof vi.fn>).mockResolvedValue({ commandsDisabled: true });
    await expect(check(handler, 'g1', 'c1')).resolves.toMatch(/disabled in this server/i);
  });

  it('blocks when the channel is disabled', async () => {
    const { handler, disabledChannelService } = build();
    (disabledChannelService.isChannelDisabled as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    await expect(check(handler, 'g1', 'c1')).resolves.toMatch(/disabled in this channel/i);
  });

  it('blocks when staff disabled the command', async () => {
    const { handler, guildDisabledCommands } = build();
    (guildDisabledCommands.isCommandDisabled as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    await expect(check(handler, 'g1', 'c1')).resolves.toMatch(/disabled.*by the staff/i);
  });

  it('blocks when the command is toggled off for the channel', async () => {
    const { handler, channelToggledCommands } = build();
    (channelToggledCommands.isCommandToggled as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    await expect(check(handler, 'g1', 'c1')).resolves.toMatch(/toggled off in this channel/i);
  });

  it('reports the FIRST failing gate and stops asking', async () => {
    // Four sequential lookups; a server that is fully disabled should not
    // then pay for three more round trips to rediscover what it already knows.
    const { handler, guildService, disabledChannelService, guildDisabledCommands, channelToggledCommands } = build();
    (guildService.getGuild as ReturnType<typeof vi.fn>).mockResolvedValue({ commandsDisabled: true });
    (disabledChannelService.isChannelDisabled as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    await check(handler, 'g1', 'c1');
    expect(disabledChannelService.isChannelDisabled).not.toHaveBeenCalled();
    expect(guildDisabledCommands.isCommandDisabled).not.toHaveBeenCalled();
    expect(channelToggledCommands.isCommandToggled).not.toHaveBeenCalled();
  });

  it('FAIL-OPENS when a lookup throws, so an outage cannot disable the bot', async () => {
    // The important one. Failing closed here would take every guild offline
    // because one cache read failed.
    const { handler, guildService } = build();
    (guildService.getGuild as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('redis down'));
    await expect(check(handler, 'g1', 'c1')).resolves.toBeNull();
  });

  it('passes the command name through to the per-command gates', async () => {
    const { handler, guildDisabledCommands, channelToggledCommands } = build();
    await check(handler, 'g1', 'c1', 'milestone');
    expect(guildDisabledCommands.isCommandDisabled).toHaveBeenCalledWith('g1', 'milestone');
    expect(channelToggledCommands.isCommandToggled).toHaveBeenCalledWith('g1', 'c1', 'milestone');
  });

  it('treats a missing guild row as not disabled', async () => {
    const { handler, guildService } = build();
    (guildService.getGuild as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(check(handler, 'g1', 'c1')).resolves.toBeNull();
  });
});
