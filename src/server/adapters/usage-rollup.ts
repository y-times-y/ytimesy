import type { TurnUsageFact } from "#/domain/usage-report";
import { type UsageDailyRow, usageProvider } from "#/domain/usage-report";
import { NOT_CANARY_CHAT } from "./canary-chat";
import { database } from "./database";

type Queryable = Pick<ReturnType<typeof database>, "query">;

const ZERO_PROJECT = "'00000000-0000-0000-0000-000000000000'::uuid";

/**
 * Adds one settled turn to its day's usage. Counted once per turn, on the
 * turn's own day, with its project, source (box, Durable Object, Y²) from the
 * turn and its chat. Bookkeeping: it never throws; a failure is logged and
 * the turn's own settlement stands.
 */
export async function recordTurnUsage(
	turnId: string,
	modelId: string,
	fact: TurnUsageFact,
	db: Queryable = database(),
): Promise<void> {
	try {
		let provider = usageProvider(modelId);
		if (provider === "other") {
			const hinted = await db.query<{ provider: string }>(
				`select c.provider from api_turn t join model_connection c on c.id=t.connection_id where t.id=$1`,
				[turnId],
			);
			provider = usageProvider(modelId, hinted.rows[0]?.provider);
		}
		await db.query(
			`with counted as (
			   insert into usage_turn_counted(turn_id,user_id)
			   select t.id,t.user_id from api_turn t where t.id=$1
			   on conflict do nothing returning user_id
			 )
			 insert into usage_daily(user_id,day,provider,model_id,project_id,source,turns,unknown_turns,input_tokens,output_tokens,cache_read_tokens)
			 select t.user_id,(t.created_at at time zone 'utc')::date,$2,$3,s.project_id,
			        case when s.chat_role='y2' then 'y2' when t.executor='durable-object' then 'durable-object' else 'box' end,
			        1,case when $4 then 0 else 1 end,$5,$6,$7
			 from counted join api_turn t on t.id=$1 join agent_session s on s.id=t.session_id
			 -- The canary's own turns are not the owner's usage (canary-chat.ts).
			 where ${NOT_CANARY_CHAT}
			 on conflict (user_id,day,provider,model_id,source,coalesce(project_id,${ZERO_PROJECT}))
			 do update set turns=usage_daily.turns+1,
			   unknown_turns=usage_daily.unknown_turns+excluded.unknown_turns,
			   input_tokens=usage_daily.input_tokens+excluded.input_tokens,
			   output_tokens=usage_daily.output_tokens+excluded.output_tokens,
			   cache_read_tokens=usage_daily.cache_read_tokens+excluded.cache_read_tokens`,
			[
				turnId,
				provider,
				modelId,
				fact.known,
				fact.known ? fact.inputTokens : 0,
				fact.known ? fact.outputTokens : 0,
				fact.known ? fact.cacheReadTokens : 0,
			],
		);
	} catch (error) {
		console.error(
			"usage rollup failed",
			error instanceof Error ? error.message : error,
		);
	}
}

/** One user's daily rows since a day: a single range scan on the unique key's prefix. */
export async function readUsageDaily(
	userId: string,
	sinceDay: string,
	db: Queryable = database(),
): Promise<UsageDailyRow[]> {
	const result = await db.query<{
		day: string;
		provider: UsageDailyRow["provider"];
		model_id: string;
		project_id: string | null;
		project_name: string | null;
		source: UsageDailyRow["source"];
		turns: number;
		unknown_turns: number;
		input_tokens: string;
		output_tokens: string;
		cache_read_tokens: string;
	}>(
		`select to_char(u.day,'YYYY-MM-DD') as day,u.provider,u.model_id,u.project_id,p.full_name as project_name,
		        u.source,u.turns,u.unknown_turns,u.input_tokens::text,u.output_tokens::text,u.cache_read_tokens::text
		 from usage_daily u left join project p on p.id=u.project_id
		 where u.user_id=$1 and u.day>=$2::date order by u.day`,
		[userId, sinceDay],
	);
	return result.rows.map((r) => ({
		day: r.day,
		provider: r.provider,
		modelId: r.model_id,
		projectId: r.project_id,
		projectName: r.project_name,
		source: r.source,
		turns: r.turns,
		unknownTurns: r.unknown_turns,
		inputTokens: Number(r.input_tokens),
		outputTokens: Number(r.output_tokens),
		cacheReadTokens: Number(r.cache_read_tokens),
	}));
}
