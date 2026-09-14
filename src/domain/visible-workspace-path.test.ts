import { describe, expect, it } from "vitest";
import { visibleWorkspacePath } from "./visible-workspace-path";

describe("visibleWorkspacePath", () => {
	it("drops the guest home prefix the way Codex shows src/hero.tsx", () => {
		expect(visibleWorkspacePath("/home/ubuntu/todo-cli/todo.py")).toBe(
			"todo-cli/todo.py",
		);
		expect(visibleWorkspacePath("/tmp/src/hero.tsx")).toBe("src/hero.tsx");
		expect(visibleWorkspacePath("src/hero.tsx")).toBe("src/hero.tsx");
	});
});
