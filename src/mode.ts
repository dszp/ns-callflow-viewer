/**
 * Truthiness for env-var flags. The one shared parser: a setting that means "on" must mean it
 * identically everywhere, or two settings end up disagreeing about `yes`.
 */
export const truthy = (v?: string): boolean =>
  ['1', 'true', 'yes', 'on'].includes((v ?? '').trim().toLowerCase());
