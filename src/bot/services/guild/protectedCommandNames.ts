/**
 * The names a moderator may never switch off, guild-wide or in a channel.
 *
 * WHY THIS IS ONE LIST AND NOT ONE LINE PER COMMAND FILE
 * ------------------------------------------------------
 * The two writers of the disable gate - `guildDisabledCommandService` (whole
 * server) and `channelToggledCommandService` / `disabledChannelService` (one
 * channel) - each have to refuse the same names, and they live in two command
 * families (text and slash) in two directories. Four copies of the array is
 * four chances to add a gate-breaker to three of them, and the failure is
 * silent and one-way: a user disables the command that re-enables the command,
 * and the channel is offline until somebody edits the database by hand.
 *
 * `channeltogglecommand` and `disabledchannel` are here for exactly that
 * reason. `disabledchannel` cannot be recovered with `channeltogglecommand`
 * alone once the wildcard `'*'` is in place, and `channeltogglecommand` is the
 * only command that can undo a per-channel name.
 *
 * Kept in a leaf module with no imports so both command families can use it
 * without importing each other.
 */
export const PROTECTED_COMMAND_NAMES: readonly string[] = [
  'serversettings',
  'togglecommand',
  'prefix',
  'settings',
  'channeltogglecommand',
  'disabledchannel',
];

export const isProtectedCommandName = (commandName: string): boolean =>
  PROTECTED_COMMAND_NAMES.includes(commandName.trim().toLowerCase());
