export interface RuntimeCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface WorkspaceProvisionOptions {
	readonly snapshotId?: string;
}

export interface WorkspaceRuntime {
	findBySlug(slug: string): Promise<string | null>;
	provision(slug: string, options?: WorkspaceProvisionOptions): Promise<string>;
	recover(providerRef: string): Promise<string>;
	exec(
		providerRef: string,
		argv: string[],
		env: Record<string, string>,
		timeoutMs: number,
	): Promise<RuntimeCommandResult>;
	writeTextFile(
		providerRef: string,
		path: string,
		contents: string,
	): Promise<void>;
	snapshot(providerRef: string, slug: string): Promise<string>;
	pause?(providerRef: string): Promise<void>;
}

export class UnconfiguredWorkspaceRuntime implements WorkspaceRuntime {
	findBySlug() {
		return Promise.resolve(null);
	}
	provision(): Promise<string> {
		return Promise.reject(
			new Error(
				"Freestyle workspace hosting is not wired in this process. Durable records are saved; retry after the workspace host is connected.",
			),
		);
	}
	recover(): Promise<string> {
		return this.provision();
	}
	exec(): Promise<RuntimeCommandResult> {
		return Promise.reject(
			new Error(
				"Freestyle workspace hosting is not wired in this process. Durable records are saved; retry after the workspace host is connected.",
			),
		);
	}
	writeTextFile(): Promise<void> {
		return this.provision().then(() => undefined);
	}
	snapshot(): Promise<string> {
		return Promise.reject(
			new Error(
				"Freestyle workspace hosting is not wired in this process. Durable records are saved; retry after the workspace host is connected.",
			),
		);
	}
}

export class MemoryWorkspaceRuntime implements WorkspaceRuntime {
	readonly machines = new Map<string, string>();
	readonly commands: {
		providerRef: string;
		argv: string[];
		envKeys: string[];
	}[] = [];
	readonly files: { providerRef: string; path: string; bytes: number }[] = [];
	snapshots = new Map<string, string>();
	constructor(private readonly execResult: RuntimeCommandResult = success) {}
	async findBySlug(slug: string) {
		return this.machines.get(slug) ?? null;
	}
	lastProvisionOptions: WorkspaceProvisionOptions | undefined;
	async provision(slug: string, options?: WorkspaceProvisionOptions) {
		this.lastProvisionOptions = options;
		const existing = this.machines.get(slug);
		if (existing) return existing;
		const providerRef = `memory:${slug}`;
		this.machines.set(slug, providerRef);
		return providerRef;
	}
	async recover(providerRef: string) {
		if (![...this.machines.values()].includes(providerRef))
			throw new Error("Workspace machine is missing.");
		return providerRef;
	}
	async exec(
		providerRef: string,
		argv: string[],
		env: Record<string, string> = {},
	) {
		this.commands.push({ providerRef, argv, envKeys: Object.keys(env) });
		return this.execResult;
	}
	async writeTextFile(providerRef: string, path: string, contents: string) {
		this.files.push({ providerRef, path, bytes: contents.length });
	}
	async snapshot(providerRef: string, slug: string) {
		if (![...this.machines.values()].includes(providerRef))
			throw new Error("Workspace machine is missing.");
		const snapshotId = `snap:${slug}`;
		this.snapshots.set(slug, snapshotId);
		return snapshotId;
	}
	readonly paused: string[] = [];
	async pause(providerRef: string) {
		if (![...this.machines.values()].includes(providerRef))
			throw new Error("Workspace machine is missing.");
		this.paused.push(providerRef);
	}
}

const success: RuntimeCommandResult = {
	exitCode: 0,
	stdout: "",
	stderr: "",
};
