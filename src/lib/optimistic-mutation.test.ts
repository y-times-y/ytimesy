import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: toastError } }));

const { cacheWrite, followOtherTabSaves, optimisticMutation } = await import(
	"./optimistic-mutation"
);

const KEY = ["switch"];

/** A server call the test answers by hand, in any order. */
function manualServer<T>() {
	const calls: {
		value: boolean;
		resolve: (data: T) => void;
		reject: (error: Error) => void;
	}[] = [];
	const call = (value: boolean) =>
		new Promise<T>((resolve, reject) => {
			calls.push({ value, resolve, reject });
		});
	return { calls, call };
}

function switchSave(
	client: QueryClient,
	call: (value: boolean) => Promise<boolean>,
	extra: { errorToast?: string; answer?: boolean } = {},
) {
	return new MutationObserver(client, {
		mutationFn: call,
		...optimisticMutation<boolean, boolean>({
			queryClient: client,
			scope: "switch",
			writes: (on) => [cacheWrite<boolean>(KEY, () => on)],
			...(extra.answer === false
				? {}
				: { serverWrites: (data) => [{ queryKey: KEY, data }] }),
			...(extra.errorToast ? { errorToast: extra.errorToast } : {}),
		}),
	});
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => toastError.mockReset());

describe("optimisticMutation", () => {
	it("shows the expected value before the server answers", async () => {
		const client = new QueryClient();
		client.setQueryData(KEY, false);
		const server = manualServer<boolean>();
		const done = switchSave(client, server.call).mutate(true);
		await flush();
		expect(client.getQueryData(KEY)).toBe(true);
		server.calls[0].resolve(true);
		await done;
		expect(client.getQueryData(KEY)).toBe(true);
	});

	it("puts the old value back and says so when the server fails", async () => {
		const client = new QueryClient();
		client.setQueryData(KEY, false);
		const server = manualServer<boolean>();
		const done = switchSave(client, server.call, {
			errorToast: "Couldn't save.",
		}).mutate(true);
		await flush();
		server.calls[0].reject(new Error("down"));
		await expect(done).rejects.toThrow("down");
		expect(client.getQueryData(KEY)).toBe(false);
		expect(toastError).toHaveBeenCalledWith("Couldn't save.");
	});

	it("sends rapid toggles one at a time and ends on the last click", async () => {
		const client = new QueryClient();
		client.setQueryData(KEY, false);
		const server = manualServer<boolean>();
		const observer = () => switchSave(client, server.call);
		const clicks = [true, false, true].map((on) => observer().mutate(on));
		await flush();
		expect(client.getQueryData(KEY)).toBe(true);
		// Only the first save is on the wire; the others wait their turn.
		expect(server.calls.map((call) => call.value)).toEqual([true]);
		server.calls[0].resolve(true);
		await flush();
		// The first answer does not overwrite the later clicks.
		expect(client.getQueryData(KEY)).toBe(true);
		expect(server.calls.map((call) => call.value)).toEqual([true, false]);
		server.calls[1].resolve(false);
		await flush();
		expect(client.getQueryData(KEY)).toBe(true);
		server.calls[2].resolve(true);
		await Promise.all(clicks);
		expect(client.getQueryData(KEY)).toBe(true);
	});

	it("keeps a later click when an earlier one fails, then matches the server", async () => {
		const client = new QueryClient();
		client.setQueryData(KEY, false);
		const server = manualServer<boolean>();
		const first = switchSave(client, server.call).mutate(true);
		const second = switchSave(client, server.call).mutate(false);
		await flush();
		server.calls[0].reject(new Error("down"));
		await expect(first).rejects.toThrow();
		expect(client.getQueryData(KEY)).toBe(false);
		await flush();
		server.calls[1].resolve(false);
		await second;
		expect(client.getQueryData(KEY)).toBe(false);
	});

	it("refetches what it wrote once the scope is idle when the server sends nothing back", async () => {
		const client = new QueryClient();
		client.setQueryData(KEY, false);
		const server = manualServer<boolean>();
		const done = switchSave(client, server.call, { answer: false }).mutate(
			true,
		);
		await flush();
		expect(client.getQueryState(KEY)?.isInvalidated).toBe(false);
		server.calls[0].resolve(true);
		await done;
		expect(client.getQueryState(KEY)?.isInvalidated).toBe(true);
	});

	it("drops a read already on its way, so it cannot undo the change", async () => {
		const client = new QueryClient();
		client.setQueryData(KEY, false);
		let answerRead: (value: boolean) => void = () => {};
		const read = client.fetchQuery({
			queryKey: KEY,
			queryFn: () =>
				new Promise<boolean>((resolve) => {
					answerRead = resolve;
				}),
		});
		const server = manualServer<boolean>();
		const done = switchSave(client, server.call).mutate(true);
		await flush();
		answerRead(false);
		await read.catch(() => undefined);
		expect(client.getQueryData(KEY)).toBe(true);
		server.calls[0].resolve(true);
		await done;
	});

	it("tells other tabs which entries changed, and they refetch them", async () => {
		const client = new QueryClient();
		client.setQueryData(KEY, false);
		const other = new QueryClient();
		other.setQueryData(KEY, false);
		const stop = followOtherTabSaves(other);
		const server = manualServer<boolean>();
		const done = switchSave(client, server.call).mutate(true);
		await flush();
		server.calls[0].resolve(true);
		await done;
		await vi.waitFor(() =>
			expect(other.getQueryState(KEY)?.isInvalidated).toBe(true),
		);
		stop();
	});
});
