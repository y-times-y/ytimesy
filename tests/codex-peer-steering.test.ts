import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("steers the active native turn, acknowledges only its matching RPC, and leaves rejection queued", () => {
	const script = `
import runpy, tempfile, os, json
m = runpy.run_path('src/server/adapters/codex/login-daemon.py')
g = m['steer_peer_messages'].__globals__
with tempfile.TemporaryDirectory(prefix='ytimesy-steer-') as root:
    g['PEER_INBOX_PATH'] = root
    sent = []
    g['send'] = lambda proc, message: sent.append(message)
    path = os.path.join(root, 'one.json')
    with open(path, 'w') as handle: json.dump({'id': 'one', 'text': 'Peer finding'}, handle)
    pending = {}
    m['steer_peer_messages'](None, 'thread', None, pending)
    assert not sent
    m['steer_peer_messages'](None, 'thread', 'active-turn', pending)
    assert len(sent) == 1
    request = sent[0]
    assert request['method'] == 'turn/steer'
    assert request['params'] == {'threadId': 'thread', 'expectedTurnId': 'active-turn', 'input': [{'type': 'text', 'text': 'Peer finding'}]}
    m['steer_peer_messages'](None, 'thread', 'active-turn', pending)
    assert len(sent) == 1
    assert not m['accept_peer_steer_reply']({'method': 'item/completed'}, 'active-turn', pending)
    assert m['accept_peer_steer_reply']({'id': request['id'], 'error': {'message': 'No active turn'}}, 'active-turn', pending)
    assert not os.path.exists(path + '.accepted')
    m['steer_peer_messages'](None, 'thread', 'active-turn', pending)
    request = sent[-1]
    m['accept_peer_steer_reply']({'id': request['id'], 'result': {'turnId': 'active-turn'}}, 'active-turn', pending)
    assert open(path + '.accepted').read().strip() == 'accepted'
    m['steer_peer_messages'](None, 'thread', 'active-turn', pending)
    assert len(sent) == 2
print('passed')
`;
	expect(
		execFileSync("python3", ["-c", script], { encoding: "utf8" }).trim(),
	).toBe("passed");
});
