import {
	BACKGROUND_EXIT_PATH,
	BACKGROUND_EXIT_TOKEN_HEADER,
	backgroundExitToken,
} from "#/domain/background-exit-wake";
import type { WorkspaceId } from "#/domain/ids";
import { posixShellQuoted as quote } from "#/domain/posix-command";
import { gitProxyConfiguration } from "../adapters/github/git-proxy-transfer";
import type { WorkspaceMachines } from "./workspace-machines";

export const BACKGROUND_EXIT_USER_AGENT = "ytimesy-exit/1";

/**
 * Posts the exit callback once, retrying a network or server error twice,
 * then deletes the request. The token is read from the private file, never
 * from argv, so the VM's process list shows only the directory. It names its
 * own User-Agent: Cloudflare refuses urllib's default (error 1010).
 */
const EXIT_CALLBACK_SCRIPT = `import json, shutil, sys, time, urllib.error, urllib.request
directory = sys.argv[1]
try:
    with open(directory + '/request.json') as handle:
        request = json.load(handle)
except (OSError, ValueError):
    sys.exit(0)
for attempt in range(3):
    try:
        urllib.request.urlopen(urllib.request.Request(request['url'], data=request['body'].encode(), method='POST', headers={'content-type': 'application/json', 'user-agent': '${BACKGROUND_EXIT_USER_AGENT}', '${BACKGROUND_EXIT_TOKEN_HEADER}': request['token']}), timeout=15).close()
        break
    except urllib.error.HTTPError as error:
        if error.code < 500:
            break
    except Exception:
        pass
    time.sleep(2)
shutil.rmtree(directory, ignore_errors=True)`;

/**
 * Prepares a background command's exit callback (background-exit-wake.ts):
 * its signed request goes in a 0700 directory beside the command's status,
 * written through the file API (not a shell argument, which other Linux users
 * could read in the process list). Returns the shell to run after the status
 * is written, or "" when no edge is configured or the write failed; the
 * cron's watcher then wakes the chat within a minute, as before.
 */
export async function prepareBackgroundExitCallback(
	machines: Pick<WorkspaceMachines, "exec" | "writeTextFile">,
	vm: WorkspaceId,
	input: { userId: string; sessionId: string; commandId: string; root: string },
): Promise<string> {
	try {
		const config = gitProxyConfiguration();
		if (!config) return "";
		const request = {
			userId: input.userId,
			sessionId: input.sessionId,
			commandId: input.commandId,
		};
		const token = await backgroundExitToken(config.secret, request);
		const directory = `${input.root}/${input.commandId}.exit`;
		const made = await machines.exec(
			vm,
			`mkdir -p ${quote(input.root)} && (umask 077 && mkdir ${quote(directory)})`,
			15_000,
		);
		if (made.exitCode) return "";
		await machines.writeTextFile(
			vm,
			`${directory}/request.json`,
			JSON.stringify({
				url: new URL(BACKGROUND_EXIT_PATH, config.origin).href,
				body: JSON.stringify(request),
				token,
			}),
		);
		return `; python3 -c ${quote(EXIT_CALLBACK_SCRIPT)} ${quote(directory)} >/dev/null 2>&1`;
	} catch {
		return "";
	}
}
