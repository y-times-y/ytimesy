import { beforeEach, expect, it, vi } from "vitest";
import { modelEndpointTransport } from "./model-endpoint";

type DnsLookup = (
	hostname: string,
	options: { all?: boolean; family?: number },
	callback: (error: Error | null, addresses: unknown, family?: number) => void,
) => void;
const mocks = vi.hoisted(() => ({
	dns: vi.fn(),
	fetch: vi.fn(),
	close: vi.fn(),
	lookup: undefined as DnsLookup | undefined,
}));
vi.mock("node:dns/promises", () => ({ lookup: mocks.dns }));
vi.mock("undici", () => ({
	fetch: mocks.fetch,
	Agent: class {
		constructor(options: { connect: { lookup: DnsLookup } }) {
			mocks.lookup = options.connect.lookup;
		}
		close = mocks.close;
	},
}));
beforeEach(() => {
	vi.clearAllMocks();
	mocks.fetch.mockResolvedValue(new Response("ok"));
});

async function resolve() {
	return new Promise<unknown>((resolve, reject) =>
		mocks.lookup?.("gateway.example", { all: true }, (error, addresses) =>
			error ? reject(error) : resolve(addresses),
		),
	);
}

it("revalidates every DNS connection and rejects a rebound private address", async () => {
	const transport = modelEndpointTransport("https://gateway.example/v1");
	mocks.dns
		.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }])
		.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
	expect(await resolve()).toEqual([{ address: "8.8.8.8", family: 4 }]);
	await expect(resolve()).rejects.toThrow("public addresses");
	await transport.close();
});

it("rejects mixed private/public DNS answers", async () => {
	const transport = modelEndpointTransport("https://gateway.example/v1");
	mocks.dns.mockResolvedValue([
		{ address: "8.8.8.8", family: 4 },
		{ address: "169.254.169.254", family: 4 },
	]);
	await expect(resolve()).rejects.toThrow("public addresses");
	await transport.close();
});

it("preserves Request method, headers, body and abort while forbidding redirects", async () => {
	const transport = modelEndpointTransport("https://gateway.example/v1");
	const abort = new AbortController();
	await transport.fetch(
		new Request("https://gateway.example/v1/chat/completions", {
			method: "POST",
			headers: { Authorization: "Bearer fixture" },
			body: "fixture-body",
			signal: abort.signal,
		}),
	);
	const options = mocks.fetch.mock.calls[0][1];
	expect(options.method).toBe("POST");
	expect(options.headers).toContainEqual(["authorization", "Bearer fixture"]);
	expect(options.redirect).toBe("manual");
	expect(await new Response(options.body).text()).toBe("fixture-body");
	abort.abort();
	expect(options.signal.aborted).toBe(true);
	await transport.close();
});
