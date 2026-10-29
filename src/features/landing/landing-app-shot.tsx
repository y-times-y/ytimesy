import {
	ArrowUp,
	Brain,
	Check,
	ChevronDown,
	Circle,
	CircleCheck,
	CircleHelp,
	Eye,
	FileDiff,
	FolderTree,
	GitBranch,
	GitMerge,
	GitPullRequest,
	Hammer,
	LayoutPanelLeft,
	LoaderCircle,
	Monitor,
	Plus,
	Search,
	SquareTerminal,
	X,
} from "lucide-react";

/**
 * The whole app at work, drawn in markup: the chats by status, a turn with
 * helpers and memory, and the Overview with the plan, helpers and the PR.
 */
export function AppShot() {
	return (
		<div className="app-shot" aria-hidden="true">
			<Sidebar />
			<Chat />
			<Inspector />
		</div>
	);
}

function Sidebar() {
	return (
		<aside className="as-sidebar">
			<div className="as-sidebar-top">
				<img src="/brand/mark.svg" width={18} height={18} alt="" />
				<LayoutPanelLeft size={14} />
			</div>
			<div className="as-new">
				<Plus size={14} />
				New chat
			</div>
			<div className="as-project">
				<ChevronDown size={12} />
				acme/web
			</div>
			<p className="as-heading">
				Needs you <span>1</span>
			</p>
			<div className="as-row">
				<span>Pick a chart library</span>
				<CircleHelp size={13} className="as-amber" />
			</div>
			<p className="as-heading">
				Working <span>2</span>
			</p>
			<div className="as-row as-row-active">
				<span className="as-shimmer">Add dark mode</span>
				<span className="as-time">2m 14s</span>
			</div>
			<div className="as-row">
				<span className="as-shimmer">Speed up search</span>
				<span className="as-time">48s</span>
			</div>
			<p className="as-heading">
				Done <span>4</span>
			</p>
			<div className="as-row">
				<span>Fix login redirect</span>
				<span className="as-pr as-green">
					<GitPullRequest size={13} />
					<Check size={11} />
				</span>
			</div>
			<div className="as-row">
				<span>Upgrade the router</span>
				<GitMerge size={13} className="as-violet" />
			</div>
			<div className="as-row">
				<span>Cache API responses</span>
				<span className="as-pr as-red">
					<GitPullRequest size={13} />
					<X size={11} />
				</span>
			</div>
			<div className="as-row as-row-unread">
				<span>Write onboarding emails</span>
				<span className="as-dot" />
			</div>
		</aside>
	);
}

function Chat() {
	return (
		<section className="as-chat">
			<header className="as-chat-head">
				<span>Add dark mode</span>
				<span className="as-branch">
					<GitBranch size={12} />
					ytimesy/dark-mode
				</span>
			</header>
			<div className="as-timeline">
				<p className="as-user">
					Add a dark mode toggle to settings. Keep the brand colors.
				</p>
				<p className="as-text">
					I'll split this up: one helper on the theme tokens, one on the
					settings page, then verify it end to end.
				</p>
				<p className="as-step">
					<Search size={13} />
					Explored 9 files
				</p>
				<div className="as-helpers">
					<p>
						<Hammer size={13} className="as-blue" />
						<strong>build-1</strong>
						<span>Theme tokens and the toggle</span>
						<Check size={13} className="as-green" />
					</p>
					<p>
						<Hammer size={13} className="as-pink" />
						<strong>build-2</strong>
						<span>Settings page</span>
						<Check size={13} className="as-green" />
					</p>
					<p>
						<CircleCheck size={13} className="as-amber" />
						<strong>verify-1</strong>
						<span className="as-shimmer">Checking it in the browser</span>
					</p>
				</div>
				<p className="as-step">
					<FileDiff size={13} />
					Edited 6 files
					<span className="as-green">+184</span>
					<span className="as-red">-37</span>
				</p>
				<p className="as-step">
					<SquareTerminal size={13} />
					pnpm test
					<span className="as-green">412 passed</span>
				</p>
				<p className="as-memory">
					<Brain size={13} />
					Saved to memory: theme colors live in tokens.css
				</p>
			</div>
			<div className="as-composer">
				<span className="as-placeholder">Ask for a follow-up</span>
				<div className="as-composer-bar">
					<span className="as-model">
						GPT-6 Astra
						<ChevronDown size={11} />
					</span>
					<span className="as-send">
						<ArrowUp size={13} />
					</span>
				</div>
			</div>
		</section>
	);
}

function Inspector() {
	return (
		<aside className="as-inspector">
			<div className="as-tabs">
				<span className="as-tab-active">Overview</span>
				<FolderTree size={14} />
				<FileDiff size={14} />
				<SquareTerminal size={14} />
				<Monitor size={14} />
				<Eye size={14} />
			</div>
			<p className="as-section">Plan</p>
			<ul className="as-plan">
				<li>
					<CircleCheck size={13} className="as-green" />
					Theme tokens
				</li>
				<li>
					<CircleCheck size={13} className="as-green" />
					Settings toggle
				</li>
				<li>
					<LoaderCircle size={13} className="as-spin" />
					Verify in the browser
				</li>
				<li className="as-plan-todo">
					<Circle size={13} />
					Open the pull request
				</li>
			</ul>
			<p className="as-section">Pull request</p>
			<div className="as-prcard">
				<div>
					<GitPullRequest size={14} className="as-green" />
					<strong>#128</strong>
					<span>ytimesy/dark-mode</span>
				</div>
				<div className="as-pr-meta">
					<span className="as-green">
						<Check size={12} />
						Checks passed
					</span>
					<span>Ready to merge</span>
				</div>
			</div>
			<p className="as-section">Preview</p>
			<div className="as-preview">
				<div className="as-page">
					<div className="as-page-nav" />
					<div className="as-page-line as-w70" />
					<div className="as-page-line as-w45" />
					<div className="as-toggle">
						<span />
					</div>
				</div>
			</div>
		</aside>
	);
}
