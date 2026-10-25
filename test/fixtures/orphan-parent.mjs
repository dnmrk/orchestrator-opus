// Stand-in service: runs one agent turn whose "claude" touches a heartbeat file forever. The test SIGKILLs this process.
import { runTurn } from '../../src/agent.ts';

const cfg = { command: `while :; do touch ${process.argv[2]}; sleep 0.1; done; true`, model: null, permissionMode: 'default', allowedTools: [], turnTimeoutMs: 60_000 };
runTurn({ cfg, cwd: process.cwd(), sessionId: 'orphan', resume: false, prompt: '', env: process.env, signal: new AbortController().signal, onEvent: () => {} }).catch(() => {});
