import { expect, it } from "vitest";
import { durableObjectLocation } from "./durable-object-location";

it("hints new objects toward the configured region and ignores anything else", () => {
	expect(
		durableObjectLocation({ YTIMESY_DURABLE_OBJECT_LOCATION_HINT: "wnam" }),
	).toEqual({ locationHint: "wnam" });
	expect(
		durableObjectLocation({ YTIMESY_DURABLE_OBJECT_LOCATION_HINT: " enam " }),
	).toEqual({ locationHint: "enam" });
	expect(durableObjectLocation({})).toBeUndefined();
	expect(
		durableObjectLocation({
			YTIMESY_DURABLE_OBJECT_LOCATION_HINT: "us-west-2",
		}),
	).toBeUndefined();
});
