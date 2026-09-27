import { expect, it } from "vitest";
import { resolveProjectFile } from "./project-files";

const roots = [
	{ name: "web", directory: "/home/ubuntu/web" },
	{ name: "api", directory: "/home/ubuntu/api" },
];
it("resolves repository-prefixed and absolute sibling paths", () => {
	expect(resolveProjectFile(roots, "api/README.md")?.path).toBe(
		"/home/ubuntu/api/README.md",
	);
	expect(
		resolveProjectFile(roots, "/home/ubuntu/api/README.md")?.relative,
	).toBe("README.md");
	expect(resolveProjectFile(roots, "README.md")?.path).toBe(
		"/home/ubuntu/web/README.md",
	);
});
it("rejects traversal and paths outside the selected repositories", () => {
	expect(resolveProjectFile(roots, "api/../../.env")).toBeNull();
	expect(resolveProjectFile(roots, "/home/ubuntu/.env")).toBeNull();
	expect(resolveProjectFile([], "README.md")).toBeNull();
});
