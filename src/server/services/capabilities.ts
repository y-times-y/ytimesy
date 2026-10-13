import { Context } from "effect";
import type { WorkspaceMachines } from "./workspace-machines";

export class WorkspaceMachineService extends Context.Tag(
	"ytimesy/WorkspaceMachineService",
)<WorkspaceMachineService, WorkspaceMachines>() {}
