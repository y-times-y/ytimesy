import { expect, it, vi } from "vitest";
import { awaitStoppedTurn } from "./await-stopped-turn";

it("waits for asynchronous cancellation before allowing wrap-up", async () => {
	const read = vi
		.fn()
		.mockResolvedValueOnce("running")
		.mockResolvedValue("idle");
	await awaitStoppedTurn(read);
	expect(read).toHaveBeenCalledTimes(2);
});

it("fails closed when cancellation has not settled", async () => {
	await expect(awaitStoppedTurn(async () => "running", 0)).rejects.toThrow(
		"no second turn was started",
	);
});
