export enum FmEmbedType {
  EmbedMini = 0,
  EmbedFull = 1,
  TextFull = 2,
  TextMini = 3,
  EmbedTiny = 4,
  TextOneLine = 5,
}

export const FmEmbedTypeNames: Record<FmEmbedType, string> = {
  [FmEmbedType.EmbedMini]: 'Embed Mini',
  [FmEmbedType.EmbedFull]: 'Embed Full',
  [FmEmbedType.TextFull]: 'Text Full',
  [FmEmbedType.TextMini]: 'Text Mini',
  [FmEmbedType.EmbedTiny]: 'Embed Tiny',
  [FmEmbedType.TextOneLine]: 'Text One Line',
};

export const FmEmbedTypeOptions: Array<{ value: FmEmbedType; label: string; description: string }> = [
  { value: FmEmbedType.EmbedMini, label: 'Embed Mini', description: 'Single track embed with cover' },
  { value: FmEmbedType.EmbedFull, label: 'Embed Full', description: 'Current + previous track with cover' },
  { value: FmEmbedType.EmbedTiny, label: 'Embed Tiny', description: 'Compact no-cover embed' },
  { value: FmEmbedType.TextFull, label: 'Text Full', description: 'Text with previous track' },
  { value: FmEmbedType.TextMini, label: 'Text Mini', description: 'Single line text' },
  { value: FmEmbedType.TextOneLine, label: 'Text One Line', description: 'Artist - Track only' },
];

export function parseFmEmbedType(value: string | null | undefined): FmEmbedType | null {
  if (!value) return null;
  const v = value.toLowerCase().trim();
  if (['embedmini', 'mini', 'embed'].includes(v)) return FmEmbedType.EmbedMini;
  if (['embedfull', 'full'].includes(v)) return FmEmbedType.EmbedFull;
  if (['embedtiny', 'tiny'].includes(v)) return FmEmbedType.EmbedTiny;
  if (['textfull'].includes(v)) return FmEmbedType.TextFull;
  if (['textmini', 'text', 'mini-text'].includes(v)) return FmEmbedType.TextMini;
  if (['textoneline', 'oneline', '1line', 'one-line', 'textonelinetiny'].includes(v)) return FmEmbedType.TextOneLine;
  return null;
}
