/**
 * TB4 watchdog: run by tb4-watchdog.timer every 5 min on the controller
 * (systemd re-arms it; Persistent=true catches up after a reboot). It never
 * depends on a session remembering to re-arm it.
 *
 * Checks: controller service alive (restarts it), stalled trials (20 min log
 * silence), host health, Bedrock throttles/5xx in the transport logs, model
 * spend (all hosts' bridge ledgers) and infra spend vs budget. Alerts go to an
 * ntfy.sh topic (free, no account): TB4_ALERT_WEBHOOK=https://ntfy.sh/<random>
 * in /opt/tb4/watchdog.env. Alerts carry counts and ids only, never secrets.
 *
 *   node --import tsx scripts/tb4-run/watchdog.ts --run-dir /opt/tb4/run [--dry-run]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { sshHostOps } from "./controller.ts";
import {
	type Alert,
	type Host,
	infraSpend,
	Journal,
	type LedgerLine,
	ledgerTotals,
	replay,
	SPEND,
	watch,
} from "./lib.ts";

type WatchState = { alerted: { model: number[]; infra: number[] }; lastSent: Record<string, number>; lastProgressAt: number; lastFinished: number };

/** Counts Bedrock throttles and 5xx in transport logs written in the last 15 min. */
export function bedrockErrors(lines: string[], sinceMs: number) {
	let throttles = 0;
	let serverErrors = 0;
	for (const line of lines) {
		let e: Record<string, unknown>;
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		const at = Date.parse(String(e.at ?? ""));
		if (!(at >= sinceMs)) continue;
		const status = Number(e.status ?? 0);
		const text = `${e.code ?? ""} ${e.error ?? ""}`;
		if (status === 429 || /Throttling|TooManyRequests|ServiceQuotaExceeded|rate.?limit/i.test(text)) throttles++;
		else if (status >= 500) serverErrors++;
	}
	return { throttles, serverErrors };
}

/** Sends one alert to the webhook; repeats of the same key are held for 60 min. */
export async function sendAlerts(alerts: Alert[], ws: WatchState, now: number, webhook: string | undefined, post = fetch) {
	const sent: string[] = [];
	for (const a of alerts) {
		const last = ws.lastSent[a.key];
		if (last !== undefined && now - last < 60 * 60_000) continue;
		ws.lastSent[a.key] = now;
		sent.push(a.key);
		if (!webhook) continue;
		await post(webhook, {
			method: "POST",
			headers: { Title: `tb4 ${a.level}`, Priority: a.level === "critical" ? "5" : "3", Tags: "tb4" },
			body: a.text,
		}).catch(() => undefined);
	}
	return sent;
}

async function main() {
	const { values } = parseArgs({ options: { "run-dir": { type: "string", default: "/opt/tb4/run" }, "dry-run": { type: "boolean", default: false } } });
	const runDir = values["run-dir"]!;
	const now = Date.now();
	const wsPath = join(runDir, "watchdog-state.json");
	const ws: WatchState = existsSync(wsPath)
		? JSON.parse(readFileSync(wsPath, "utf8"))
		: { alerted: { model: [], infra: [] }, lastSent: {}, lastProgressAt: now, lastFinished: 0 };
	const journal = new Journal(join(runDir, "journal.jsonl"));
	const state = replay(journal.events());
	const hosts = JSON.parse(readFileSync(join(runDir, "hosts.json"), "utf8")) as (Host & { type: string; launchedAt: number })[];
	const ops = sshHostOps(runDir);

	const finished = [...state.attempts.values()].filter((a) => a.status === "finished").length;
	const newlyFinished = finished - ws.lastFinished;
	if (newlyFinished > 0) ws.lastProgressAt = now;

	// Log silence per in-flight trial: mtime of its trial.log on the host.
	const logSilenceMs = new Map<string, number>();
	const transportLines: string[] = [];
	const ledgerLines: LedgerLine[] = [];
	const unhealthyHosts: string[] = [];
	const ssh = (h: Host, cmd: string) =>
		execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", h.address, cmd], { encoding: "utf8", timeout: 30_000 });
	for (const h of hosts) {
		if (!ops.health(h).ok) unhealthyHosts.push(h.name);
		try {
			const ids = [...state.attempts.values()].filter((a) => a.host === h.name && a.status !== "finished").map((a) => a.attemptId);
			if (ids.length) {
				const out = ssh(h, ids.map((id) => `echo ${id} $(( $(date +%s) - $(stat -c %Y $(ls -t /opt/tb4/jobs/${id}/*/trial.log /opt/tb4/jobs/${id}/transport.log 2>/dev/null | head -1) 2>/dev/null || date +%s) ))`).join("; "));
				for (const line of out.trim().split("\n")) {
					const [id, secs] = line.split(" ");
					logSilenceMs.set(id, Number(secs) * 1000);
				}
			}
			transportLines.push(...ssh(h, "find /opt/tb4/jobs -name transport.log -mmin -16 -exec tail -n 400 {} + 2>/dev/null || true").split("\n"));
			ledgerLines.push(
				...ssh(h, "cat /opt/tb4/ledger.jsonl 2>/dev/null || true")
					.split("\n")
					.flatMap((l) => {
						try {
							return [JSON.parse(l) as LedgerLine];
						} catch {
							return [];
						}
					}),
			);
		} catch {
			unhealthyHosts.push(h.name);
		}
	}
	const ledger = ledgerTotals(ledgerLines);
	const modelSpendUsd = ledger.settled;
	const infraSpendUsd = infraSpend(hosts.map((h) => ({ type: h.type, launchedAt: h.launchedAt })), now);
	let controllerActive = true;
	try {
		controllerActive = execFileSync("systemctl", ["is-active", "tb4-controller.service"], { encoding: "utf8" }).trim() === "active";
	} catch {
		controllerActive = false;
	}
	const { alerts, actions } = watch({
		now,
		state,
		logSilenceMs,
		unhealthyHosts: [...new Set(unhealthyHosts)],
		bedrockErrorsLast15m: bedrockErrors(transportLines, now - 15 * 60_000),
		modelSpendUsd,
		infraSpendUsd,
		alerted: ws.alerted,
		controllerActive,
		lastProgressAt: ws.lastProgressAt,
	});
	if (newlyFinished > 0)
		alerts.push({ level: "info", key: `progress-${finished}`, text: `${newlyFinished} trial(s) finished; ${finished} total, model $${modelSpendUsd.toFixed(0)} settled + $${ledger.reserved.toFixed(0)} reserved, infra ~$${infraSpendUsd.toFixed(0)}` });
	for (const a of alerts) {
		const m = /^(model|infra)-spend-([\d.]+)$/.exec(a.key);
		if (m) ws.alerted[m[1] as "model" | "infra"].push(Number(m[2]));
	}
	if (!values["dry-run"]) {
		for (const action of actions) {
			if (action === "restart-controller") execFileSync("sudo", ["systemctl", "restart", "tb4-controller.service"]);
			else if (action.startsWith("pause:") && !state.paused) journal.append({ at: new Date(now).toISOString(), type: "pause", reason: action.slice(6) });
			else if (action === "stop:model-cap") {
				// The bridge refuses every new trial on every host; running trials finish.
				for (const h of hosts) try { ssh(h, "touch /opt/tb4/ledger.jsonl.stop"); } catch {}
				if (!state.stopped) journal.append({ at: new Date(now).toISOString(), type: "stop", reason: "model spend cap" });
			}
		}
		await sendAlerts(alerts, ws, now, process.env.TB4_ALERT_WEBHOOK);
	}
	ws.lastFinished = finished;
	writeFileSync(wsPath, JSON.stringify(ws));
	console.log(JSON.stringify({ at: new Date(now).toISOString(), alerts: alerts.map((a) => a.key), actions, modelSpendUsd, infraSpendUsd: Math.round(infraSpendUsd), capUsd: SPEND.modelTotalCapUsd }));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
