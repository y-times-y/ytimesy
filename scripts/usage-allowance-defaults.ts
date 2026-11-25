/**
 * Default per-user cloud usage allowances (micro-USD of machine cost) for the
 * two rolling windows. A deployment's environment overrides them; these are
 * what a deploy sets when it does not.
 */
export const DEFAULT_USER_SHORT_WINDOW_MICRO_USD = "6000000";
export const DEFAULT_USER_WEEKLY_MICRO_USD = "30000000";
