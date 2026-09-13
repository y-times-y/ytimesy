# Codex / Freestyle integration proof

Run from the repository root with the ignored `.env` containing `FREESTYLE_API_KEY`.
This is an operator-only smoke test, not a production session service.

1. `pnpm cloud:proof prepare` creates or reuses the labeled `ytimesy-codex-proof` VM and installs Codex 0.152.1 in the guest user's directory.
2. `pnpm cloud:proof login` starts device authorization. Run `pnpm cloud:proof login-code` and complete the official OpenAI browser flow. Start only one login at a time; let a previous code expire before restarting.
3. `pnpm cloud:proof status` checks authentication. This command can wake a paused VM through its exec call.
4. `pnpm cloud:proof verify` connects over app-server stdio, requires ChatGPT authentication, discovers a model, and requests one file edit. Success requires a completed turn and exact file-content verification. It removes the previous proof file before each attempt. This consumes subscription usage.
5. `pnpm cloud:proof pause` pauses compute while preserving the isolated login. `pnpm cloud:proof delete` permanently removes this proof VM and its credentials. Both check the VM ownership label first.

The VM has outbound Internet access, no configured public application endpoint, a five-minute idle timeout, a 30-minute per-run cap, and a 24-hour deletion deadline. These bounds apply to this disposable proof only. It contains no application `.env`, GitHub App private key, or database credentials. Codex performs its own device login and stores its credentials inside the VM. No local Codex authentication cache is copied.

The installed base image defaults exec to `ubuntu`. Global npm installation is not writable there; the proof uses `/home/ubuntu/ytimesy-agent`. Rigkit configuration and snapshot workflows still need a separate validation. Do not cache authenticated snapshots as shared base images.

The runner checks subscription authentication before starting inference and never falls back to an API key. It declines unsupported app-server requests. The 120-second deadline bounds a proof attempt. Production transport still needs durable event cursors, cancellation, approval handling, reconnection, ownership checks, and supervised process recovery.

A create error is not a reason to choose another slug and retry: inspect the stable slug first to reconcile an ambiguous response. The 24-hour deadline also limits an orphan's lifetime if the caller loses the create response.

Sources verified 2026-09-13: [Freestyle VMs](https://www.freestyle.sh/docs/vms), installed Freestyle SDK 0.2.13, [Codex headless authentication](https://developers.openai.com/codex/auth), and the locally generated Codex 0.152.1 app-server protocol types. Rigkit setup reference: [docs interface](https://www.rigkit.dev/docs/bash).
