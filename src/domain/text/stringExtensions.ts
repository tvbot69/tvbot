export const formatNumber = (value: number): string =>
  value.toLocaleString('en-US');

export const truncate = (value: string, maxLength: number): string =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
