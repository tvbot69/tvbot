import { createHash } from 'crypto';

export const createLastfmSignature = (
  params: Record<string, string>,
  secret: string,
): string => {
  const signature = Object.entries(params)
    .filter(([key]) => key !== 'format')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}${value}`)
    .join('');

  return createHash('md5').update(`${signature}${secret}`).digest('hex');
};
