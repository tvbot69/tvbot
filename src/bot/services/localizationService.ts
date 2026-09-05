import { Localizer } from '@bot/models/localizer';

export class LocalizationService {
  public getLocalizer(_guildId?: string | null): Localizer {
    return new Localizer('en');
  }

  public getLanguage(_guildId?: string | null): string {
    return 'en';
  }
}
