import en from '@bot/resources/locales/en.json';

type LocaleTree = { [key: string]: string | LocaleTree };

const locales: Record<string, LocaleTree> = {
  en: en as LocaleTree,
};

export class Localizer {
  public readonly language: string;

  constructor(language: string = 'en') {
    this.language = language;
  }

  public localize(key: string, params?: Record<string, string>): string {
    const tree = locales[this.language] ?? locales.en!;
    let node: string | LocaleTree | undefined = tree;
    for (const part of key.split('.')) {
      if (node && typeof node === 'object' && part in node) {
        node = node[part];
      } else {
        const fallback = locales.en!;
        node = fallback;
        for (const p of key.split('.')) {
          if (node && typeof node === 'object' && p in node) {
            node = node[p];
          } else {
            return key;
          }
        }
        break;
      }
    }
    if (typeof node !== 'string') {
      return key;
    }
    let result = node;
    if (params) {
      for (const [name, value] of Object.entries(params)) {
        result = result.replace(new RegExp(`{{${name}}}`, 'g'), value);
      }
    }
    return result;
  }
}
