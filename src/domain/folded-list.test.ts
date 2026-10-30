import { expect, it } from "vitest";
import { foldFinished } from "./folded-list";

const items = ["a:done", "b:open", "c:done", "d:done", "e:open", "f:done"];
const done = (item: string) => item.endsWith(":done");

it("keeps open items and the last finished ones, in order", () => {
	expect(foldFinished(items, done, 2)).toEqual({
		shown: ["b:open", "d:done", "e:open", "f:done"],
		hidden: 2,
	});
	expect(foldFinished(items, done, 0)).toEqual({
		shown: ["b:open", "e:open"],
		hidden: 4,
	});
	expect(foldFinished(items, done, 4)).toEqual({ shown: items, hidden: 0 });
});
