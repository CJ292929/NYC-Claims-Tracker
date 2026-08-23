/**
 * Shared clinic username normalization: trims and lowercases so lookups and
 * rate-limit keys agree with the case-insensitive UNIQUE(lower(username))
 * index on public.clinic_users.
 */
export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

/**
 * Escapes ILIKE pattern metacharacters (%, _, \) so a normalized username can
 * be used as an exact case-insensitive match rather than a wildcard pattern.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, ch => `\\${ch}`);
}
