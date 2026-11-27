import { writeFileSync, readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { Button } from "#/components/ui/button";
import { Badge } from "#/components/ui/badge";
import { Input } from "#/components/ui/input";
import { Textarea } from "#/components/ui/textarea";
import { Label } from "#/components/ui/label";
import { Switch } from "#/components/ui/switch";
import { Separator } from "#/components/ui/separator";
import { ClaudeMark } from "#/features/sessions/claude-mark";
import { CodexMark } from "#/features/sessions/codex-mark";
import { ModelProviderLogo } from "#/features/sessions/model-provider-logo";
import { canvasInstructions, CANVAS_SANDBOX, CANVAS_CSP } from "#/domain/canvas";

const css = readFileSync(process.argv[2], "utf8");

const ACC = {
	claude: "#d97757",
	openai: "#34a98a",
	gemini: "#5b8def",
	deepseek: "#7c83ff",
	grok: "#b7b7b7",
};

/* ---------- small pieces ---------- */
const Hat = () => (
	<svg viewBox="0 0 16 16" width="11" height="11" className="hat" aria-hidden="true">
		<path d="M2 11h12l-1.2-5L8 8 3.2 6z" fill="currentColor" />
		<circle cx="8" cy="4.6" r="1.3" fill="currentColor" />
	</svg>
);
function Avatar({ name, color, leader, size = 28, status }: { name: string; color: string; leader?: boolean; size?: number; status?: "working" | "idle" | "needs" }) {
	return (
		<span className="av" style={{ width: size, height: size, background: color, fontSize: size * 0.42 }}>
			{name[0].toUpperCase()}
			{leader && <Hat />}
			{status && <i className={`dot ${status}`} />}
		</span>
	);
}

/* ---------- artifact renderers (new; token-based) ---------- */
function Bars({ data, w = 520, h = 150, accentIdx = -1 }: { data: { l: string; v: number }[]; w?: number; h?: number; accentIdx?: number }) {
	const max = Math.max(...data.map((d) => d.v));
	const bw = (w - 20) / data.length;
	return (
		<svg viewBox={`0 0 ${w} ${h + 22}`} role="img" aria-label={`Bar chart: ${data.map((d) => `${d.l} ${d.v}`).join(", ")}`} className="chart">
			{[0.25, 0.5, 0.75, 1].map((t) => (
				<line key={t} x1="0" x2={w} y1={h - h * t} y2={h - h * t} className="grid" />
			))}
			{data.map((d, i) => {
				const bh = (d.v / max) * (h - 6);
				return (
					<g key={d.l}>
						<rect x={10 + i * bw + 4} y={h - bh} width={bw - 8} height={bh} rx="3" fill={i === accentIdx ? "var(--acc)" : "var(--chart-2)"} />
						<text x={10 + i * bw + bw / 2} y={h + 15} textAnchor="middle" className="axis">{d.l}</text>
					</g>
				);
			})}
		</svg>
	);
}
function Funnel() {
	const rows = [["X post views", 2436, 1], ["Site visitors", 70, 0.34], ["GitHub stars", 10, 0.12]] as const;
	return (
		<div className="funnel">
			{rows.map(([l, v, p]) => (
				<div key={l} className="frow">
					<span>{l}</span>
					<span className="fbar"><b style={{ width: `${p * 100}%` }} /></span>
					<span className="num">{v.toLocaleString("en")}</span>
				</div>
			))}
		</div>
	);
}

function DashboardArtifact({ tab = "Traffic", mobile }: { tab?: "Traffic" | "Funnel"; mobile?: boolean }) {
	const data = [["0h", 210], ["1h", 640], ["2h", 590], ["3h", 520], ["4h", 476]].map(([l, v]) => ({ l: l as string, v: v as number }));
	return (
		<figure className="art" aria-label="Artifact: edge.here launch, first 5 hours">
			<header className="art-h">
				<span className="art-t">edge.here launch, first 5 hours</span>
				<span className="art-k">stat · chart</span>
				<span className="art-a">
					<button type="button" aria-label="Copy as image">⧉</button>
					<button type="button" aria-label="Expand to canvas panel">⤢</button>
				</span>
			</header>
			<div className="stats">
				<div><small>X post views</small><b>2,436</b></div>
				<div><small>Site visitors</small><b>70</b></div>
				<div><small>GitHub stars</small><b>10</b></div>
			</div>
			<div className="tabs" role="tablist">
				{["Traffic", "Funnel"].map((t) => (
					<button key={t} role="tab" aria-selected={t === tab} className={t === tab ? "on" : ""} type="button">{t}</button>
				))}
			</div>
			<div className="art-body" role="tabpanel">
				{tab === "Traffic" ? <Bars data={data} w={mobile ? 300 : 520} accentIdx={1} /> : <Funnel />}
			</div>
			<figcaption className="art-f">Demo data · rendered from a typed spec, 1.4 KB</figcaption>
		</figure>
	);
}
function TableArtifact() {
	return (
		<figure className="art" aria-label="Artifact: top pages">
			<header className="art-h"><span className="art-t">Top pages by visitors</span><span className="art-k">table</span></header>
			<table className="tbl">
				<thead><tr><th>Page</th><th className="r">Visitors</th><th className="r">Δ</th></tr></thead>
				<tbody>
					<tr><td>/</td><td className="r">41</td><td className="r">+12</td></tr>
					<tr><td>/docs/quickstart</td><td className="r">17</td><td className="r">+9</td></tr>
					<tr><td>/pricing</td><td className="r">12</td><td className="r">+3</td></tr>
				</tbody>
			</table>
		</figure>
	);
}
function StreamingArtifact() {
	return (
		<figure className="art" aria-busy="true" aria-label="Artifact streaming">
			<header className="art-h"><span className="art-t">Building chart…</span><span className="art-k">streaming</span></header>
			<div className="skel"><i /><i /><i style={{ height: 38 }} /></div>
			<figcaption className="art-f">The JSON spec arrives in pieces; the card draws once it parses, bars grow in place. A spec that never parses shows its source as a code block.</figcaption>
		</figure>
	);
}
function HtmlCard() {
	return (
		<figure className="art" aria-label="Artifact: HTML card">
			<header className="art-h"><span className="art-t">Pricing slider</span><span className="art-k">html · sandboxed</span><span className="art-a"><button type="button" aria-label="Expand">⤢</button></span></header>
			<div className="htmlbox"><span className="lock">sandbox="{CANVAS_SANDBOX}" · opaque origin · connect-src 'none'</span><div className="fake">  ▭▭▭▭▭▭▭▭▭▭▭▬▬▬▬▬  </div></div>
		</figure>
	);
}

/* ---------- chat ---------- */
function Msg({ who, children, user }: { who?: string; children: ReactNode; user?: boolean }) {
	return <div className={`msg ${user ? "user" : ""}`}>{!user && who && <div className="who">{who}</div>}{children}</div>;
}
function ChatBefore() {
	return (
		<div className="chat">
			<Msg user>Chart the first five hours of the edge.here launch.</Msg>
			<Msg who="Super agent"><p>Here is the breakdown. I opened a canvas so you can see it.</p>
				<div className="canvascard"><div className="thumb">▭ ▭ ▭</div><div><b>Launch dashboard</b><small>Canvas · tap Open to see it in the right panel</small></div><Button variant="outline" size="sm">Open</Button></div>
				<p className="muted">The numbers live in a separate panel; the transcript only keeps a thumbnail.</p>
			</Msg>
		</div>
	);
}
function ChatAfter({ mobile, tab }: { mobile?: boolean; tab?: "Traffic" | "Funnel" }) {
	return (
		<div className="chat">
			<Msg user>Chart the first five hours of the edge.here launch.</Msg>
			<Msg who="Super agent">
				<p>Views peaked in hour 1; only about 3% of viewers reached the site.</p>
				<DashboardArtifact mobile={mobile} tab={tab} />
				{!mobile && <TableArtifact />}
			</Msg>
		</div>
	);
}
function Composer() { return <div className="composer"><span>Message Super agent, or @seo…</span><Button size="sm">Send</Button></div>; }

/* ---------- sidebar ---------- */
const CAPS = [
	{ n: "apm", c: ACC.claude, s: "working" as const, m: "Reviewing 3 open release PRs", t: "2m", g: "" },
	{ n: "posttr", c: ACC.gemini, s: "idle" as const, m: "Scheduled 4 posts for Thursday", t: "1h", g: "" },
	{ n: "edit.here", c: ACC.openai, s: "needs" as const, m: "Needs you: approve the headline?", t: "3h", g: "" },
	{ n: "seo", c: ACC.deepseek, s: "idle" as const, m: "Found 6 pages missing meta", t: "5h", g: "content" },
	{ n: "newsletter", c: ACC.grok, s: "working" as const, m: "Drafting issue 14 from changelog", t: "6m", g: "content" },
	{ n: "content", c: ACC.claude, s: "idle" as const, m: "Nothing to report", t: "1d", g: "content" },
];
function CaptRow({ c }: { c: (typeof CAPS)[number] }) {
	return (
		<div className="crow">
			<Avatar name={c.n} color={c.c} status={c.s} />
			<div className="ctext"><b>{c.n}</b><small>{c.m}</small></div>
			<span className="ago">{c.t}</span>
		</div>
	);
}
function SidebarBefore() {
	return (
		<aside className="side">
			<div className="side-top"><b>ytimesy</b></div>
			<div className="grp">Projects</div>
			<div className="prow on"><span className="pdot" />edge.here<small>3 threads</small></div>
			<div className="prow sub"><span className="pdot ys" />Super agent<small>Watching 3 threads</small></div>
			<div className="prow sub">Fix hydration flash</div>
			<div className="prow sub">Add pricing page</div>
			<div className="prow"><span className="pdot" />ytimesy-docs<small>No threads yet</small></div>
		</aside>
	);
}
function SidebarAfter({ empty, menu }: { empty?: boolean; menu?: boolean }) {
	const content = CAPS.filter((c) => c.g), plain = CAPS.filter((c) => !c.g);
	return (
		<aside className="side">
			<div className="side-top"><b>ytimesy</b></div>
			<div className="grp row">Captains<span><button type="button" aria-label="New captain">+</button><button type="button" aria-label="Captains menu">···</button></span></div>
			<div className="crow lead">
				<Avatar name="otto" color="#e5e5e5" leader status="working" />
				<div className="ctext"><b>otto <Badge variant="secondary">leader</Badge></b><small>Watching 3 threads · 2 captains working</small></div><span className="ago">now</span>
			</div>
			{empty ? (
				<div className="empty">
					<b>Give your Super agent a team</b>
					<p>Captains are Super agents with a role: SEO, newsletter, release manager. They sleep until you @mention them or something happens, and they report to otto.</p>
					<Button size="sm">+ New captain</Button>
					<div className="chips"><span>SEO</span><span>Newsletter</span><span>Release manager</span><span>Support triage</span></div>
				</div>
			) : (
				<>
					{plain.map((c) => <CaptRow key={c.n} c={c} />)}
					<div className="grp">content <small>{content.length}</small></div>
					{content.map((c) => <CaptRow key={c.n} c={c} />)}
				</>
			)}
			{menu && (
				<div className="menu"><div>Group by label</div><div>Show archived</div><div>Captain limits (3 of 5)</div></div>
			)}
			<div className="grp">Threads</div>
			<div className="prow sub">Fix hydration flash</div>
			<div className="prow sub">Add pricing page</div>
		</aside>
	);
}

/* ---------- create dialog ---------- */
function CreateDialog({ mobile }: { mobile?: boolean }) {
	const perms = [["Read every thread in the project", true, false], ["Start and message threads", true, false], ["Open pull requests (never merge)", true, false], ["Schedules and check-ins", true, false], ["Merge, deploy, delete, spend", false, true]] as const;
	return (
		<div className="dlg" style={{ width: mobile ? 358 : 520 }}>
			<h3>New captain</h3>
			<div className="f2">
				<div className="fld"><Label htmlFor="cn">Name</Label><Input id="cn" defaultValue="seo" /></div>
				<div className="fld"><Label htmlFor="cl">Label</Label><Input id="cl" defaultValue="content" /></div>
			</div>
			<div className="fld"><Label>Colour</Label>
				<div className="sw">{Object.values(ACC).map((c, i) => <span key={c} className={i === 3 ? "on" : ""} style={{ background: c }} />)}</div></div>
			<div className="fld"><Label htmlFor="cr">Role instructions</Label>
				<Textarea id="cr" rows={4} defaultValue={"You own SEO for this project. Each Monday audit titles, meta and links of changed pages and start one thread per fix. Report to otto only what needs a decision."} /></div>
			<div className="fld"><Label>What it may do</Label>
				{perms.map(([t, on, locked]) => (
					<label key={t} className="perm"><Switch defaultChecked={on} disabled={locked} size="sm" /><span>{t}</span>{locked && <Badge variant="outline">always you</Badge>}</label>
				))}
			</div>
			<div className="fld"><Label>Wake on</Label><div className="chips on"><span>@mention</span><span>Schedule</span><span>Thread events</span><span className="off">Every push</span></div></div>
			<p className="muted">Uses the project's model connection and counts against the same usage caps. No machine of its own.</p>
			<div className="dlg-f"><Button variant="ghost">Cancel</Button><Button>Create captain</Button></div>
		</div>
	);
}

/* ---------- chat with captain / mention ---------- */
function CaptainChat({ mobile }: { mobile?: boolean }) {
	return (
		<div className="chat">
			<Msg user>@seo audit the pricing page, then tell otto what you found.</Msg>
			<Msg who="seo · captain"><p>On it. Started thread “Fix pricing meta” and reported to otto.</p>
				<div className="relay">↳ seo → otto: 6 pages missing meta; 1 thread started; nothing needs you.</div>
				{!mobile && <TableArtifact />}</Msg>
		</div>
	);
}

/* ---------- artboards ---------- */
function Board({ label, w, h, theme, children }: { label: string; w: number; h: number; theme: "dark" | "light"; children: ReactNode }) {
	return (
		<div className="bwrap">
			<div className="blabel">{label}</div>
			<div data-artboard className={`board ${theme === "dark" ? "dark" : "lt"}`} style={{ width: w, height: h }}>{children}</div>
		</div>
	);
}
const Desk = ({ side, main, panel }: { side: ReactNode; main: ReactNode; panel?: ReactNode }) => (
	<div className="desk">{side}<main>{main}<Composer /></main>{panel}</div>
);
function Phone({ children, title }: { children: ReactNode; title: string }) {
	return <div className="phone"><div className="ptop"><span>☰</span><b>{title}</b><span>⋯</span></div>{children}<Composer /></div>;
}
function Panel() { return <aside className="panel"><div className="ph"><b>Canvas</b><span>edge.here launch · rev 1</span><button type="button">✕</button></div><div className="pbody"><DashboardArtifact tab="Funnel" /></div></aside>; }

function Doc({ children, w }: { children: ReactNode; w?: number }) {
	return <div className="doc" style={{ width: w }}>{children}</div>;
}

const specJson = `\`\`\`artifact
{ "v": 1, "type": "dashboard", "title": "edge.here launch, first 5 hours",
  "stats": [ {"label":"X post views","value":2436},
             {"label":"Site visitors","value":70},
             {"label":"GitHub stars","value":10} ],
  "tabs": [
    {"name":"Traffic","chart":{"kind":"bar","x":["0h","1h","2h","3h","4h"],
                               "series":[{"name":"Views","y":[210,640,590,520,476]}]}},
    {"name":"Funnel","chart":{"kind":"funnel","steps":[["X post views",2436],["Site visitors",70],["GitHub stars",10]]}} ] }
\`\`\``;

const instr = canvasInstructions().slice(0, 420);

function Page() {
	return (
		<div className="page">
			<Doc w={1500}>
				<h1>Artifacts and captains design</h1>
				<p className="lede">Design only; nothing is built or deployed. Demo data throughout (the launch numbers come from the Capy screenshot). Real parts: the app's compiled <code>styles.css</code>, <code>Button</code>, <code>Badge</code>, <code>Input</code>, <code>Textarea</code>, <code>Label</code>, <code>Switch</code>, <code>ModelProviderLogo</code> and <code>canvasInstructions()</code> output. Mock parts (do not exist yet): the artifact renderer, the Captains sidebar section, the create dialog. The app has no light theme today; the light boards override the shadcn tokens to show what the artifact would need.</p>
				<div className="decide">
					<div><b>Cost rule</b><span>Zero new always-on objects. Artifacts: client-only rendering, no server component. Captains: rows in the existing per-project crew Durable Object and Postgres; no DO, VM or alarm per captain.</span></div>
					<div><b>One concept</b><span>A captain is a Super agent chat with a name, role prompt and tool scope. The leader (Y², “otto”) is the one that always exists.</span></div>
					<div><b>Recommendation</b><span>Ship artifacts first (small, no cost), then captains in two steps: static captains, then wake.</span></div>
				</div>
			</Doc>

			<h2 className="sec">A. Inline artifacts in chat</h2>
			<div className="row">
				<Board label="Before · desktop (dark): canvas card, content lives in a panel" w={760} h={520} theme="dark"><Desk side={<SidebarBefore />} main={<ChatBefore />} /></Board>
				<Board label="After · desktop (dark): dashboard inside the message, tabs, expand, copy" w={760} h={760} theme="dark"><Desk side={<SidebarBefore />} main={<ChatAfter />} /></Board>
				<Board label="After · desktop (light): expanded to the canvas panel" w={980} h={760} theme="light"><Desk side={<SidebarBefore />} main={<ChatAfter tab="Funnel" />} panel={<Panel />} /></Board>
			</div>
			<div className="row">
				<Board label="Before · 390 px" w={390} h={640} theme="dark"><Phone title="Super agent"><ChatBefore /></Phone></Board>
				<Board label="After · 390 px (dark)" w={390} h={640} theme="dark"><Phone title="Super agent"><ChatAfter mobile /></Phone></Board>
				<Board label="After · 390 px (light), Funnel tab" w={390} h={640} theme="light"><Phone title="Super agent"><ChatAfter mobile tab="Funnel" /></Phone></Board>
				<Board label="States: streaming, HTML card, table" w={460} h={640} theme="dark"><div className="chat pad"><StreamingArtifact /><HtmlCard /><TableArtifact /></div></Board>
			</div>
			<Doc w={1500}>
				<div className="cols3">
					<div>
						<h3>How the model makes one</h3>
						<p>Two doors, one schema, validated by the same parser:</p>
						<ul>
							<li><b>Fenced block</b> <code>```artifact</code> with typed JSON in the reply. Works for every runner with no tool support; parsed as it streams (render when the JSON closes).</li>
							<li><b><code>artifact</code> tool</b> for box turns and Claude Code (an MCP tool beside <code>mcp__…__canvas</code>), result stored as an item so it persists and revisions work like canvases.</li>
							<li><b>HTML card</b>: <code>kind:"html"</code> reuses the canvas frame, sandbox <code>{CANVAS_SANDBOX}</code>, no <code>allow-same-origin</code>, and the existing CSP (<code>connect-src 'none'</code>, <code>default-src 'none'</code>).</li>
						</ul>
						<pre>{specJson}</pre>
					</div>
					<div>
						<h3>Types and limits (v1)</h3>
						<table className="tbl"><thead><tr><th>Type</th><th>Limit</th></tr></thead><tbody>
							<tr><td>stat, checklist, timeline</td><td>≤ 24 items</td></tr>
							<tr><td>bar / line / funnel</td><td>≤ 6 series × 200 points</td></tr>
							<tr><td>table</td><td>≤ 200 rows × 12 cols</td></tr>
							<tr><td>tabs</td><td>≤ 6 per artifact</td></tr>
							<tr><td>one spec</td><td>≤ 64 KB; ≤ 8 per message</td></tr>
							<tr><td>HTML card</td><td>≤ 200 KB, counts in the 2 MB chat budget</td></tr>
							<tr><td>image</td><td>data: URL ≤ 1 MB, or an existing attachment id</td></tr>
						</tbody></table>
						<p className="muted">Diagram type is cut from v1 (an HTML card covers it). Unknown fields are dropped; invalid specs render the source as a code block, never an error.</p>
					</div>
					<div>
						<h3>Safety, style, access</h3>
						<ul>
							<li>Typed specs are <b>data, never code</b>: React renders SVG from numbers; text goes through the existing inline-markdown sanitizer; no URLs except <code>https:</code> link cells with <code>rel=noopener</code>.</li>
							<li>HTML cards run only in the sandboxed frame: no network, no cookies, no parent access (same as canvases today).</li>
							<li>Black and white by default (tokens <code>--chart-1…5</code>), one accent (the model's provider colour) highlights the key series. Light and dark through tokens; value labels and a visually-hidden data table for screen readers; tabs follow the ARIA tablist pattern with arrow keys; no colour-only meaning.</li>
							<li>Copy as image: serialise the SVG to PNG client-side (canvas), no server. Export CSV for tables.</li>
							<li>Persisted as a normal transcript item (the spec JSON), so history, search and replays need no new store.</li>
						</ul>
					</div>
				</div>
				<h3>How each runner learns it</h3>
				<table className="tbl wide"><thead><tr><th>Runner</th><th>How</th><th>Effort</th></tr></thead><tbody>
					<tr><td>Box turns (api-turn)</td><td>Extend the canvas block in <code>agent-turn-instructions.ts</code> next to <code>canvasInstructions()</code> with an <code>artifactInstructions()</code> in <code>src/domain/canvas.ts</code> (schema, 2 examples, “use sparingly, one per answer”); register the tool.</td><td>S</td></tr>
					<tr><td>Claude Code runner</td><td><code>claude-code-runner.ts</code> already passes <code>canvasInstructions("mcp__…__canvas")</code>; add the same for the <code>artifact</code> MCP tool, and the fenced block works as fallback.</td><td>S</td></tr>
					<tr><td>Y² (Super agent)</td><td>Y² only reports: allow the fenced block in its replies (digest stats, thread status tables). No tool, so no cost and no VM. Its <code>show_canvas</code> already relays threads' canvases; add <code>show_artifact</code> the same way.</td><td>S</td></tr>
				</tbody></table>
				<p className="muted">Today's instructions, first characters, as rendered from the real function: <code>{instr.replace(/\n/g, " ")}…</code></p>
			</Doc>

			<h2 className="sec">B. Captains</h2>
			<div className="row">
				<Board label="Before · desktop: one Super agent row per project" w={620} h={420} theme="dark"><Desk side={<SidebarBefore />} main={<div className="chat"><Msg who="Super agent"><p>Watching 3 threads. Nothing needs you.</p></Msg></div>} /></Board>
				<Board label="After · desktop (dark): leader otto + captains, grouped by label" w={900} h={700} theme="dark"><Desk side={<SidebarAfter />} main={<CaptainChat />} /></Board>
				<Board label="After · desktop (light): “···” menu open" w={760} h={700} theme="light"><Desk side={<SidebarAfter menu />} main={<CaptainChat />} /></Board>
			</div>
			<div className="row">
				<Board label="Empty state · desktop" w={760} h={560} theme="dark"><Desk side={<SidebarAfter empty />} main={<div className="chat"><Msg who="otto · Super agent"><p>I’m your project’s leader. Add captains for recurring jobs and I’ll delegate to them and keep their status here.</p></Msg></div>} /></Board>
				<Board label="Create captain · dialog (dark)" w={600} h={820} theme="dark"><div className="center"><CreateDialog /></div></Board>
				<Board label="Create captain · 390 px (light)" w={390} h={820} theme="light"><div className="center"><CreateDialog mobile /></div></Board>
			</div>
			<div className="row">
				<Board label="Sidebar · 390 px (dark)" w={390} h={760} theme="dark"><div className="phone"><SidebarAfter /></div></Board>
				<Board label="Empty state · 390 px (light)" w={390} h={560} theme="light"><div className="phone"><SidebarAfter empty /></div></Board>
				<Board label="@mention in any chat · 390 px (dark)" w={390} h={560} theme="dark"><Phone title="Add pricing page"><div className="chat"><Msg user>@seo is the pricing page indexable?</Msg><Msg who="seo · captain"><p>Yes, but the title is 71 characters. Started “Fix pricing meta”.</p></Msg></div></Phone></Board>
			</div>
			<Doc w={1500}>
				<div className="cols3">
					<div>
						<h3>Model: a captain is a Super agent with a role</h3>
						<ul>
							<li><b>Leader</b>: today's Y², always exactly one, never deletable, shown as “otto” (renamable). Delegates, digests, sees every captain's status.</li>
							<li><b>Captain</b>: name, label (group), colour, role prompt, tool scope, its own chat and memory notes. Same tools as Y² minus the blocked ones below; it starts and messages threads, and reports to the leader with one line.</li>
							<li><b>Summon</b>: <code>@seo</code> in any chat enqueues a wake for that captain with the message; <code>message_captain</code> tool lets the leader delegate.</li>
							<li><b>Status</b>: idle / working / needs you, from the crew row (no polling). Last line and time ago come from <code>last_line</code>, <code>last_at</code> on the captain row.</li>
							<li><b>Limit</b>: 5 captains per project to start, 20 wakes a day each inside the existing 200-a-day user cap. Captains cannot create captains.</li>
						</ul>
						<h3>Safety</h3>
						<ul>
							<li>Captains can read, start/message/stop/retry threads, schedule and ask you. They cannot merge, deploy, delete, change settings, or spend: those return a needs-you item, exactly as Y² does.</li>
							<li>Mention chains: depth 2, and a captain cannot wake the one that woke it within 10 minutes. Loop brakes reuse <code>CREW_WAKES_PER_HOUR</code>.</li>
							<li>Role prompt is data appended to Y²'s fixed rules; it cannot loosen them. Tool scope is enforced server-side in the tool handler, not by the prompt.</li>
						</ul>
					</div>
					<div>
						<h3>Data (additive migration, nothing renamed)</h3>
						<pre>{`-- Postgres
create table captain (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references project(id) on delete cascade,
  chat_id uuid,            -- its own Super agent chat
  name text not null, label text,
  color text not null, avatar text,
  role_prompt text not null,   -- <= 4000 chars
  tool_scope jsonb not null default '{}',
  position int not null default 0,
  last_line text, last_at timestamptz,
  archived_at timestamptz, created_at timestamptz default now(),
  unique (project_id, name)
);
-- cap of 5 enforced in the insert function
alter table memory_note add column captain_id uuid null;

-- crew DO (SQLite, per project, already exists)
alter table wake_state add column captain_id text not null default '';
-- '' = leader; one row per captain, one shared alarm slot`}</pre>
						<p className="muted">The crew's single alarm is already armed to the earliest pending wake, heartbeat or schedule; it simply takes the minimum over captain rows. No second alarm, no DO per captain.</p>
					</div>
					<div>
						<h3>Cost at 100 power users (estimate)</h3>
						<table className="tbl"><thead><tr><th>Item</th><th className="r">Added</th></tr></thead><tbody>
							<tr><td>Assume</td><td className="r">3 captains each, ~25 real wakes/day</td></tr>
							<tr><td>Model turns</td><td className="r">+7,500/day on users' own plans; ceiling unchanged (200/user/day shared)</td></tr>
							<tr><td>Crew DO requests</td><td className="r">+~0.5 M/mo (total ~1.4 M vs 1 M included ≈ +$0.06)</td></tr>
							<tr><td>DO duration</td><td className="r">+≤ 28k GB-s/mo (upper bound 1 s/wake) on top of ~30k</td></tr>
							<tr><td>Worker requests</td><td className="r">+~0.3 M/mo (10 M included)</td></tr>
							<tr><td>Supabase egress</td><td className="r">+~2 GB/mo</td></tr>
							<tr><td>Idle cost per captain</td><td className="r"><b>0</b></td></tr>
						</tbody></table>
						<p className="muted"><b>Caveat:</b> the DO duration cap was hit this month, which says the existing Y² estimate in docs/y.md is probably low. Before building wake, measure real crew duration per wake from the Cloudflare analytics and redo this table; these numbers are extrapolations, not measurements.</p>
						<div className="prov"><span><ClaudeMark size={14} /> Claude</span><span><CodexMark size={14} /> Codex</span><span><ModelProviderLogo provider="google" size={14} /> Gemini</span><span><ModelProviderLogo provider="deepseek" size={14} /> DeepSeek</span> share one connection</div>
					</div>
				</div>
			</Doc>

			<h2 className="sec">C. Phased plan</h2>
			<Doc w={1500}>
				<table className="tbl wide"><thead><tr><th>#</th><th>Phase</th><th>Size</th><th>Risk</th></tr></thead><tbody>
					<tr><td>0</td><td>Measure crew DO duration per wake and Y² requests from Cloudflare analytics; fix the cost model before adding wakes.</td><td>S (½ d)</td><td>Low</td></tr>
					<tr><td>1</td><td><b>Artifact v1</b>: schema + parser + sanitiser (domain), renderer for stat, bar/line, table, checklist, timeline, fenced block and <code>artifact</code> tool, transcript item, instructions for box turns, Claude Code and Y², dark/light, tests.</td><td>M (5–7 d)</td><td>Streaming partial render and chat-cache/page-read interplay</td></tr>
					<tr><td>2</td><td>Tabs, expand to canvas panel, copy as image / CSV, accessibility pass, HTML card via existing frame.</td><td>S–M (3–4 d)</td><td>PNG export of SVG fonts on Safari</td></tr>
					<tr><td>3</td><td><b>Captains, static</b>: migration, create/rename/archive, sidebar section, own chat, role prompt injected into Y²'s prompt, @mention that just opens the captain chat, 5 cap.</td><td>M (5–6 d)</td><td>Sidebar and chat lists assume one Y² per project; touches <code>ensureYSquaredChat</code>, crew scope</td></tr>
					<tr><td>4</td><td><b>Captains, awake</b>: crew rows per captain, wake gate and caps per captain, @mention wake, <code>message_captain</code>/report-to-leader, status and last line, loop limits, scoped tools enforced in handlers.</td><td><b>L (10–15 d)</b></td><td>The largest and riskiest part: crew store, alarms (restart on every deploy), cap accounting, loop protection, and the cost caveat</td></tr>
					<tr><td>5</td><td>Per-captain schedules, labels/grouping UI polish, per-captain memory notes.</td><td>M (4–5 d)</td><td>Memory scoping touches retrieval</td></tr>
				</tbody></table>
				<div className="cols2">
					<div><h3>Recommended order</h3><p>0 → 1 → 2 (visible win, no new cost) → 3 → 4 → 5. Ship 3 before 4: users get named, role-prompted agents they talk to directly, and we learn whether they want autonomy before paying for wakes.</p></div>
					<div><h3>What I would cut</h3><p>Diagram and image artifact types in v1; cross-project captains; captain-to-captain chat (only via the leader); a model per captain; server-side image export; captains created by agents; a light theme beyond the artifact tokens. Honest size: phases 1 and 4 are the big ones; 4 is more than twice the rest of captains combined.</p></div>
				</div>
				<div className="ctas">
					<button type="button" data-ytimesy-prompt="Approved: build phase 0 and phase 1 (artifacts v1) first, then stop and show me.">Approve phases 0–1</button>
					<button type="button" data-ytimesy-prompt="Approved: build artifacts (phases 0–2) and static captains (phase 3); hold phase 4 until the cost measurement.">Approve 0–3</button>
					<button type="button" data-ytimesy-prompt="Change the design: ">Request changes</button>
				</div>
			</Doc>
		</div>
	);
}

const mock = `
.page{padding:48px;background:#050505;color:#ededed;display:flex;flex-direction:column;gap:40px;width:max-content}
.doc{background:#0c0c0c;border:1px solid #ffffff17;border-radius:14px;padding:28px;font-size:13px;line-height:1.55;color:#d8d8d8}
.doc h1{font-size:28px;margin:0 0 8px;color:#fff}.doc h3{font-size:14px;margin:14px 0 6px;color:#fff}
.lede{max-width:1100px;color:#a8a8a8}.sec{font-size:22px;margin:8px 0 -16px;color:#fff}
code{background:#ffffff12;padding:1px 5px;border-radius:4px;font-size:11.5px}
pre{background:#050505;border:1px solid #ffffff14;border-radius:8px;padding:10px;font-size:11px;line-height:1.45;overflow:hidden;white-space:pre-wrap;color:#cfcfcf}
.decide{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:14px}.decide div{border:1px solid #ffffff1a;border-radius:10px;padding:12px}.decide b{display:block;color:#fff;margin-bottom:4px}.decide span{color:#b0b0b0}
.cols3{display:grid;grid-template-columns:repeat(3,1fr);gap:28px}.cols2{display:grid;grid-template-columns:1fr 1fr;gap:28px}
.row{display:flex;flex-wrap:nowrap;gap:48px;align-items:flex-start}
.bwrap{flex:none}.blabel{font-size:12px;color:#9a9a9a;margin-bottom:8px;max-width:760px}
.board{border:1px solid #ffffff1f;border-radius:12px;overflow:hidden;background:var(--background);color:var(--foreground);font-size:13px;line-height:1.5;position:relative}
.lt{--background:#fff;--foreground:#0a0a0a;--card:#fafafa;--card-foreground:#0a0a0a;--muted:#f2f2f2;--muted-foreground:#6a6a6a;--border:#0000001a;--primary:#171717;--primary-foreground:#fafafa;--secondary:#f2f2f2;--secondary-foreground:#171717;--input:#00000026;--accent:#f2f2f2;--ring:#999;--chart-1:#171717;--chart-2:#8a8a8a;--popover:#fff;border-color:#0000001f;color-scheme:light}
.board{--acc:#d97757;--chart-2:oklch(0.556 0 0)}.lt{--chart-2:#9a9a9a}
.desk{display:flex;height:100%}.desk main{flex:1;min-width:0;display:flex;flex-direction:column;border-left:1px solid var(--border)}
.side{width:250px;flex:none;padding:12px 8px;background:var(--card);overflow:hidden;position:relative}.phone .side{width:auto;height:100%;background:transparent}
.side-top{padding:4px 10px 10px}.grp{font-size:11px;color:var(--muted-foreground);padding:10px 10px 4px;font-weight:500;display:flex;gap:6px}.grp.row{justify-content:space-between;align-items:center}.grp small{opacity:.7}
.grp button{background:none;border:0;color:var(--muted-foreground);font-size:15px;padding:0 5px;cursor:pointer}
.prow{padding:6px 10px;border-radius:8px;display:flex;flex-direction:column}.prow.on,.crow.lead{background:var(--muted)}.prow small{color:var(--muted-foreground);font-size:11px}.prow.sub{padding-left:22px;font-size:12.5px;color:var(--muted-foreground)}
.pdot{display:none}
.crow{display:flex;align-items:center;gap:10px;padding:6px 10px;border-radius:8px;min-height:44px}.crow:hover{background:var(--muted)}
.ctext{flex:1;min-width:0;display:flex;flex-direction:column}.ctext b{font-weight:500;display:flex;gap:6px;align-items:center}.ctext small{color:var(--muted-foreground);font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ago{font-size:11px;color:var(--muted-foreground)}
.av{position:relative;display:inline-flex;align-items:center;justify-content:center;border-radius:50%;color:#0a0a0a;font-weight:600;flex:none}
.av .hat{position:absolute;top:-6px;left:50%;transform:translateX(-50%) rotate(-8deg);color:var(--foreground)}
.dot{position:absolute;right:-1px;bottom:-1px;width:9px;height:9px;border-radius:50%;border:2px solid var(--card);background:#6a6a6a}.dot.working{background:#46b546}.dot.needs{background:#e5a84b}
.empty{margin:10px;padding:14px;border:1px dashed var(--border);border-radius:10px;display:flex;flex-direction:column;gap:8px}.empty p{margin:0;color:var(--muted-foreground);font-size:12px}
.chips{display:flex;flex-wrap:wrap;gap:6px}.chips span{border:1px solid var(--border);border-radius:99px;padding:2px 9px;font-size:11px;color:var(--muted-foreground)}.chips.on span{color:var(--foreground);background:var(--muted)}.chips.on span.off{opacity:.45;text-decoration:line-through}
.menu{position:absolute;right:10px;top:60px;background:var(--popover);border:1px solid var(--border);border-radius:10px;padding:4px;box-shadow:0 8px 24px #0006;z-index:3}.menu div{padding:6px 12px;border-radius:6px;font-size:12.5px}.menu div:first-child{background:var(--muted)}
.chat{flex:1;padding:18px;display:flex;flex-direction:column;gap:14px;overflow:hidden}.chat.pad{padding:14px}
.msg{max-width:100%}.msg.user{align-self:flex-end;background:var(--muted);padding:8px 12px;border-radius:12px;max-width:80%}.who{font-size:11px;color:var(--muted-foreground);margin-bottom:4px}.msg p{margin:0 0 8px}.muted{color:var(--muted-foreground)}.doc .muted{color:#8f8f8f}
.relay{border-left:2px solid var(--acc);padding:2px 10px;color:var(--muted-foreground);font-size:12px;margin-bottom:8px}
.composer{margin:12px;border:1px solid var(--border);border-radius:12px;padding:8px 8px 8px 12px;display:flex;justify-content:space-between;align-items:center;color:var(--muted-foreground)}
.canvascard{display:flex;gap:12px;align-items:center;border:1px solid var(--border);border-radius:10px;padding:10px}.canvascard .thumb{width:64px;height:44px;background:var(--muted);border-radius:6px;display:grid;place-items:center;color:var(--muted-foreground)}.canvascard small{display:block;color:var(--muted-foreground)}.canvascard>div:nth-child(2){flex:1}
.art{margin:6px 0 10px;border:1px solid var(--border);border-radius:12px;background:var(--card);overflow:hidden}
.art-h{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--border)}.art-t{font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.art-k{font-size:10px;color:var(--muted-foreground);border:1px solid var(--border);border-radius:99px;padding:0 7px}
.art-a button{background:none;border:0;color:var(--muted-foreground);font-size:14px;cursor:pointer;padding:2px 5px}
.stats{display:flex;gap:0;border-bottom:1px solid var(--border)}.stats div{flex:1;padding:10px 12px;border-right:1px solid var(--border)}.stats div:last-child{border:0}.stats small{display:block;color:var(--muted-foreground);font-size:11px}.stats b{font-size:22px;font-weight:600;letter-spacing:-.02em}
.tabs{display:flex;gap:4px;padding:8px 12px 0}.tabs button{background:none;border:0;padding:4px 10px;border-radius:6px;color:var(--muted-foreground);font:inherit;font-size:12px}.tabs button.on{background:var(--muted);color:var(--foreground)}
.art-body{padding:8px 12px 10px}.chart{width:100%;height:auto}.chart .grid{stroke:var(--border);stroke-width:1}.chart .axis{fill:var(--muted-foreground);font-size:10px}
.funnel .frow{display:grid;grid-template-columns:100px 1fr 50px;gap:10px;align-items:center;padding:6px 0;font-size:12px}.fbar{height:10px;background:var(--muted);border-radius:99px;overflow:hidden}.fbar b{display:block;height:100%;background:var(--acc);border-radius:99px}.num{text-align:right;font-variant-numeric:tabular-nums}
.art-f{padding:6px 12px;border-top:1px solid var(--border);font-size:11px;color:var(--muted-foreground)}
.skel{padding:12px;display:flex;gap:8px;align-items:flex-end;height:90px}.skel i{flex:1;height:60px;background:var(--muted);border-radius:4px}
.htmlbox{padding:12px}.lock{display:block;font-size:10.5px;color:var(--muted-foreground);margin-bottom:6px}.fake{height:56px;border:1px dashed var(--border);border-radius:8px;display:grid;place-items:center;color:var(--muted-foreground)}
.tbl{border-collapse:collapse;width:100%;font-size:12px}.tbl th,.tbl td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--border,#ffffff1a);vertical-align:top}.tbl th{font-weight:500;color:var(--muted-foreground,#8f8f8f)}.tbl .r{text-align:right}.doc .tbl{--border:#ffffff1a}.tbl.wide{margin:6px 0 12px}.doc li{margin-bottom:5px}.doc ul{padding-left:18px;margin:6px 0}
.panel{width:380px;flex:none;border-left:1px solid var(--border);display:flex;flex-direction:column}.ph{display:flex;gap:8px;align-items:center;padding:10px 12px;border-bottom:1px solid var(--border)}.ph span{flex:1;color:var(--muted-foreground);font-size:12px}.ph button{background:none;border:0;color:inherit}.pbody{padding:12px}
.phone{height:100%;display:flex;flex-direction:column}.ptop{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-bottom:1px solid var(--border)}
.center{height:100%;display:grid;place-items:center;background:#0000004d}.lt .center{background:#0000001a}
.dlg{background:var(--popover);border:1px solid var(--border);border-radius:14px;padding:18px;display:flex;flex-direction:column;gap:12px;box-shadow:0 20px 60px #0008}.dlg h3{margin:0;font-size:16px}.fld{display:flex;flex-direction:column;gap:6px}.f2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.sw{display:flex;gap:8px}.sw span{width:22px;height:22px;border-radius:50%}.sw span.on{outline:2px solid var(--foreground);outline-offset:2px}.perm{display:flex;align-items:center;gap:10px;font-size:12.5px}.dlg-f{display:flex;justify-content:flex-end;gap:8px}
.prov{margin-top:8px;display:flex;flex-wrap:wrap;gap:12px;color:#b5b5b5;font-size:12px}.prov span{display:inline-flex;gap:5px;align-items:center}
.ctas{display:flex;gap:10px;margin-top:10px}.ctas button{background:#ededed;color:#0a0a0a;border:0;border-radius:8px;padding:8px 14px;font:inherit;font-weight:500;cursor:pointer}.ctas button:last-child{background:transparent;color:#ededed;border:1px solid #ffffff33}
`;

const html = `<!doctype html><html class="dark"><head><meta charset="utf-8"><title>Artifacts and captains design</title><style>${css}</style><style>${mock}</style></head><body style="margin:0;background:#050505">${renderToStaticMarkup(<Page />)}</body></html>`;
writeFileSync(process.argv[3], html);
console.log("bytes", html.length, "csp", CANVAS_CSP.length);
