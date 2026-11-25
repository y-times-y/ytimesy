import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Check, Copy, Share2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { postOnXUrl, REFERRAL_SHARE_TEXT } from "#/domain/referral";
import {
	referralCountsFn,
	referralFn,
	setReferralEnabledFn,
} from "./referral.fn";

/** The account's referral code, link and counts. Undefined while loading or where referral is off. */
export function useReferral() {
	const read = useServerFn(referralFn);
	const query = useQuery({
		queryKey: ["referral"],
		queryFn: () => read(),
		staleTime: 60_000,
		retry: false,
	});
	return query.data?.enabled ? query.data : undefined;
}

const COPIED_MS = 2000;

/** The link in a read-only field, a copy icon that shows a check once copied, and Post on X. */
export function ReferralLinkField({ link }: { link: string }) {
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	const copy = () => {
		navigator.clipboard.writeText(link).then(
			() => {
				setCopied(true);
				clearTimeout(timer.current);
				timer.current = setTimeout(() => setCopied(false), COPIED_MS);
			},
			() => toast.error("Couldn't copy to the clipboard."),
		);
	};
	// The phone's share sheet where there is one; otherwise the link is copied.
	const share = () => {
		if (typeof navigator.share !== "function") return copy();
		navigator
			.share({ title: "ytimesy", text: REFERRAL_SHARE_TEXT, url: link })
			.catch(() => undefined);
	};
	return (
		<div className="referral-actions">
			<div className="referral-link">
				<input
					readOnly
					value={link.replace(/^https?:\/\//, "")}
					aria-label="Your referral link"
					onFocus={(event) => event.currentTarget.select()}
				/>
				<button
					type="button"
					className="referral-icon"
					aria-label={copied ? "Copied" : "Copy link"}
					title={copied ? "Copied" : "Copy link"}
					onClick={copy}
				>
					{copied ? <Check size={14} /> : <Copy size={14} />}
				</button>
			</div>
			<button
				type="button"
				className="settings-secondary referral-x"
				onClick={share}
			>
				<Share2 size={13} />
				Share
			</button>
			<a
				className="settings-secondary referral-x"
				href={postOnXUrl(link)}
				target="_blank"
				rel="noopener noreferrer"
			>
				<XMark />
				Post on X
			</a>
			<span className="referral-status" role="status">
				{copied ? "Link copied" : ""}
			</span>
		</div>
	);
}

function XMark() {
	return (
		<svg
			width="13"
			height="13"
			viewBox="0 0 24 24"
			fill="currentColor"
			aria-hidden="true"
		>
			<path d="M18.9 2H22l-7.4 8.5L23 22h-6.8l-5.3-6.9L4.8 22H1.7l7.9-9.1L1.3 2h7l4.8 6.3L18.9 2Zm-1.2 18h1.7L6.6 3.9H4.8L17.7 20Z" />
		</svg>
	);
}

/**
 * Shown in place of the usage warning: an invitation, in the app's
 * black-and-white notification style. The text says when work resumes (or how
 * full the window is) and what an invited friend earns both of them.
 */
export function ReferralInviteCard({
	title,
	message,
	link,
	onDismiss,
}: {
	title: string;
	message: string;
	link: string;
	onDismiss: () => void;
}) {
	return (
		<div className="usage-warning-banner referral-invite" role="status">
			<div className="referral-head">
				<strong>{title}</strong>
				<button
					type="button"
					className="referral-dismiss"
					aria-label="Dismiss"
					onClick={onDismiss}
				>
					×
				</button>
			</div>
			<p>{message}</p>
			<ReferralLinkField link={link} />
		</div>
	);
}

function formatDate(iso: string) {
	return new Date(iso).toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
	});
}

/** What a friend who joins gets, and what the sharer gets: the sharer's part ends at the cap. */
export function referralOfferText(capped: boolean) {
	return capped
		? "Friends who join with your link and finish their first task get a fresh usage window."
		: "When a friend joins with your link and finishes their first task, you both get a fresh usage window.";
}

/** Settings → Referral. */
export function ReferralSection({ admin }: { admin: boolean }) {
	const referral = useReferral();
	const capped = referral
		? referral.rewardsInPeriod >= referral.rewardsCap
		: false;
	return (
		<section className="settings-section" aria-label="Referral">
			<header className="settings-section-head">
				<div>
					<h3>Referral</h3>
					<p>Share your link anywhere. {referralOfferText(capped)}</p>
				</div>
			</header>
			{referral ? (
				<>
					<div className="settings-group">
						<div className="settings-row referral-link-row">
							<div className="settings-row-text">
								<span className="settings-row-title">Your link</span>
								<ReferralLinkField link={referral.link} />
							</div>
						</div>
						<div className="settings-row">
							<span className="settings-row-title">Joined with your link</span>
							<span className="settings-row-value">{referral.joined}</span>
						</div>
						<div className="settings-row">
							<div className="settings-row-text">
								<span className="settings-row-title">Your rewards</span>
								<span className="settings-row-meta">
									{capped && referral.nextAvailableAt
										? `Resets when the window moves: the next one opens ${formatDate(referral.nextAvailableAt)}.`
										: "Per rolling 30 days."}
								</span>
							</div>
							<span className="settings-row-value">
								{referral.rewardsInPeriod} of {referral.rewardsCap} used
							</span>
						</div>
						{referral.readyResets > 0 ? (
							<div className="settings-row">
								<div className="settings-row-text">
									<span className="settings-row-title">
										{referral.readyResets === 1
											? "1 reset ready"
											: `${referral.readyResets} resets ready`}
									</span>
									<span className="settings-row-meta">
										It applies by itself when you reach your usage limit.
									</span>
								</div>
							</div>
						) : null}
					</div>
					<p className="settings-row-meta referral-note">
						A reset restarts your cloud usage window. It does not affect plans
						you connect yourself.
					</p>
				</>
			) : (
				<p className="settings-copy">Referral is not available right now.</p>
			)}
			{admin ? <ReferralAdmin /> : null}
		</section>
	);
}

/** For the operator: the counts by status and reason, and the kill switch. */
function ReferralAdmin() {
	const cache = useQueryClient();
	const readCounts = useServerFn(referralCountsFn);
	const setEnabled = useServerFn(setReferralEnabledFn);
	const counts = useQuery({
		queryKey: ["referral-counts"],
		queryFn: () => readCounts(),
		retry: false,
	});
	const toggle = useMutation({
		mutationFn: (enabled: boolean) => setEnabled({ data: { enabled } }),
		onSuccess: (next) => {
			cache.setQueryData(["referral-counts"], next);
			void cache.invalidateQueries({ queryKey: ["referral"] });
		},
		onError: () => toast.error("Couldn't change the referral setting."),
	});
	if (!counts.data) return null;
	return (
		<section
			className="settings-group referral-admin"
			aria-label="Referral monitoring"
		>
			<div className="settings-row">
				<div className="settings-row-text">
					<span className="settings-row-title">
						Referral is {counts.data.enabled ? "on" : "paused"}
					</span>
					<span className="settings-row-meta">
						Paused: no new attribution, no rewards, no prompts. Pending
						referrals are kept. {counts.data.rewardsLastDay} rewards in the last
						day.
					</span>
				</div>
				<button
					type="button"
					className="settings-secondary"
					disabled={toggle.isPending}
					onClick={() => toggle.mutate(!counts.data.enabled)}
				>
					{counts.data.enabled ? "Pause referral" : "Resume referral"}
				</button>
			</div>
			{counts.data.byStatus.map((entry) => (
				<div
					className="settings-row"
					key={`${entry.status}:${entry.reason ?? ""}`}
				>
					<span className="settings-row-title">
						{entry.status}
						{entry.reason ? ` · ${entry.reason}` : ""}
					</span>
					<span className="settings-row-value">{entry.count}</span>
				</div>
			))}
		</section>
	);
}
