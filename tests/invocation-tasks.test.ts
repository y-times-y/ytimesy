import { expect, it } from "vitest";
import {
	trackInvocationTask,
	withInvocationTasks,
} from "../src/server/adapters/invocation-tasks";

it("drains floating work and nested work before leaving its invocation", async () => {
	const events: string[] = [];
	await withInvocationTasks(async () => {
		void trackInvocationTask(
			Promise.resolve().then(() => {
				events.push("first");
				void trackInvocationTask(
					Promise.resolve().then(() => {
						events.push("nested");
					}),
				);
			}),
		);
		return "saved";
	});
	expect(events).toEqual(["first", "nested"]);
});
it("does not replace the primary failure with a best-effort failure", async () => {
	await expect(
		withInvocationTasks(async () => {
			void trackInvocationTask(Promise.reject(new Error("telemetry")));
			throw new Error("primary");
		}),
	).rejects.toThrow("primary");
});
it("keeps concurrent invocation work isolated", async () => {
	let release!: () => void;
	const delayed = new Promise<void>((resolve) => {
		release = resolve;
	});
	const first = withInvocationTasks(async () => {
		void trackInvocationTask(delayed);
	});
	expect(await withInvocationTasks(async () => "second")).toBe("second");
	release();
	await first;
});
