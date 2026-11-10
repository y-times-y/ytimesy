export const CLEANUP_DEFAULTS: {
	sessionMaxAgeMs: number;
	runMaxAgeMs: number;
	highWatermark: number;
	lowWatermark: number;
	activeWindowMs: number;
};
export function cleanup(input: {
	home: string;
	now?: number;
	usage?: (home: string) => Promise<number>;
	sessionMaxAgeMs?: number;
	runMaxAgeMs?: number;
	highWatermark?: number;
	lowWatermark?: number;
	activeWindowMs?: number;
}): Promise<{ runs: number; sessions: number; bytes: number }>;
