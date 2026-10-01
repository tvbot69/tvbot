import { injectable } from 'tsyringe';

@injectable()
export class ShortcutService {
  // Map<discordUserId, Map<shortcutName, targetCommand>>
  private readonly shortcuts = new Map<string, Map<string, string>>();

  public getShortcuts(discordUserId: string): Array<{ name: string; command: string }> {
    const userMap = this.shortcuts.get(discordUserId);
    if (!userMap) return [];
    return Array.from(userMap.entries()).map(([name, command]) => ({ name, command }));
  }

  public setShortcut(discordUserId: string, name: string, command: string): void {
    const cleanName = name.toLowerCase().replace(/^[./!]+/, '');
    const cleanCmd = command.replace(/^[./!]+/, '');

    let userMap = this.shortcuts.get(discordUserId);
    if (!userMap) {
      userMap = new Map<string, string>();
      this.shortcuts.set(discordUserId, userMap);
    }
    userMap.set(cleanName, cleanCmd);
  }

  public removeShortcut(discordUserId: string, name: string): boolean {
    const cleanName = name.toLowerCase().replace(/^[./!]+/, '');
    const userMap = this.shortcuts.get(discordUserId);
    if (!userMap) return false;
    return userMap.delete(cleanName);
  }

  public resolveShortcut(discordUserId: string, inputCommand: string): string | null {
    const cleanInput = inputCommand.toLowerCase().replace(/^[./!]+/, '');
    const userMap = this.shortcuts.get(discordUserId);
    if (!userMap) return null;
    return userMap.get(cleanInput) ?? null;
  }
}
