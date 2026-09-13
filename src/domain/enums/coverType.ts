export enum CoverType {
  Motion = 1,
  Still = 2,
}

export const CoverTypeNames: Record<CoverType, string> = {
  [CoverType.Motion]: 'Motion',
  [CoverType.Still]: 'Still',
};

export const CoverTypeDescriptions: Record<CoverType, string> = {
  [CoverType.Motion]: 'Show animated covers when available (default)',
  [CoverType.Still]: 'Always show the static album cover',
};
