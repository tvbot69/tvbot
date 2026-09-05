export const getTimeAgo = (date: Date): string => {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

  if (seconds < 60) return 'just now';

  const intervals: Array<[number, string]> = [
    [31536000, 'year'],
    [2592000, 'month'],
    [604800, 'week'],
    [86400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
  ];

  for (const [secondsInInterval, name] of intervals) {
    const amount = Math.floor(seconds / secondsInInterval);
    if (amount >= 1) {
      return `${amount} ${name}${amount > 1 ? 's' : ''} ago`;
    }
  }
  return 'just now';
};

export const formatNumber = (value: number): string =>
  value.toLocaleString('en-US');

export const truncate = (value: string, maxLength: number): string =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
