// installed by herdr
// managed by herdr; reinstalling or updating the integration overwrites this file.
// add custom hooks/plugins beside this file instead of editing it.
// HERDR_INTEGRATION_ID=pi
// HERDR_INTEGRATION_VERSION=9
// @ts-nocheck

import net from "node:net";

const HERDR_ENV = process.env.HERDR_ENV;
const socketPath = process.env.HERDR_SOCKET_PATH;
const socketEndpoint =
  process.platform === "win32" && socketPath ? `\\\\.\\pipe\\${socketPath}` : socketPath;
const paneId = process.env.HERDR_PANE_ID;
const source = "herdr:pi";
const STATE_RETRY_INITIAL_DELAY_MS = 250;
const STATE_RETRY_MAX_DELAY_MS = 2000;

function enabled() {
  return HERDR_ENV === "1" && !!socketPath && !!paneId;
}

function sendRequestAttempt(
  request: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!enabled()) {
    return Promise.resolve(true);
  }
  if (signal?.aborted) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    let done = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const socket = net.createConnection(socketEndpoint!);
    const onError = () => finish(false);
    const onConnect = () => {
      try {
        socket.write(`${JSON.stringify(request)}\n`);
      } catch {
        finish(false);
      }
    };
    const onData = () => finish(true);
    const onEnd = () => finish(false);
    const onAbort = () => finish(false);
    const finish = (delivered: boolean) => {
      if (done) return;
      done = true;
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      socket.off("error", onError);
      socket.off("connect", onConnect);
      socket.off("data", onData);
      socket.off("end", onEnd);
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      resolve(delivered);
    };

    socket.on("error", onError);
    socket.on("connect", onConnect);
    socket.on("data", onData);
    socket.on("end", onEnd);
    signal?.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(() => finish(false), timeoutMs);
    timeout.unref?.();
    if (signal?.aborted) {
      finish(false);
    }
  });
}

async function sendRequest(request: unknown, signal?: AbortSignal): Promise<boolean> {
  if (await sendRequestAttempt(request, 500, signal)) {
    return true;
  }
  if (signal?.aborted) {
    return false;
  }
  return sendRequestAttempt(request, 1500, signal);
}

type AgentState = "working" | "blocked" | "idle";

type QueuedState = {
  state: AgentState;
  message?: string;
  seq: number;
};

let reportSeq = Date.now() * 1000;
let currentAgentSessionId: string | undefined;
let currentAgentSessionPath: string | undefined;

function nextReportSeq(): number {
  reportSeq += 1;
  return reportSeq;
}

function updateSessionRef(ctx: any): void {
  try {
    const file = ctx?.sessionManager?.getSessionFile?.();
    currentAgentSessionPath =
      typeof file === "string" && file.startsWith("/") ? file : undefined;
  } catch {
    currentAgentSessionPath = undefined;
  }

  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    currentAgentSessionId = typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    currentAgentSessionId = undefined;
  }
}

function withSessionRef(params: Record<string, unknown>): Record<string, unknown> {
  if (currentAgentSessionPath) {
    return { ...params, agent_session_path: currentAgentSessionPath };
  }
  if (currentAgentSessionId) {
    return { ...params, agent_session_id: currentAgentSessionId };
  }
  return params;
}

function currentSessionRef(): Record<string, unknown> | undefined {
  if (currentAgentSessionPath) {
    return { agent_session_path: currentAgentSessionPath };
  }
  if (currentAgentSessionId) {
    return { agent_session_id: currentAgentSessionId };
  }
  return undefined;
}

async function reportSession(
  sessionStartSource?: string,
  signal?: AbortSignal,
): Promise<void> {
  const sessionRef = currentSessionRef();
  if (!sessionRef) {
    return;
  }

  await sendRequest(
    {
      id: `${source}:session:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      method: "pane.report_agent_session",
      params: {
        pane_id: paneId,
        source,
        agent: "pi",
        seq: nextReportSeq(),
        session_start_source: sessionStartSource,
        ...sessionRef,
      },
    },
    signal,
  );
}

function sendState(
  state: AgentState,
  message?: string,
  seq = nextReportSeq(),
  signal?: AbortSignal,
): Promise<boolean> {
  return sendRequest(
    {
      id: `${source}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      method: "pane.report_agent",
      params: withSessionRef({
        pane_id: paneId,
        source,
        agent: "pi",
        state,
        message,
        seq,
      }),
    },
    signal,
  );
}

export default function (pi) {
  if (!enabled()) {
    return;
  }

  let agentActive = false;
  let blockedCount = 0;
  let blockedMessage: string | undefined;
  let lastState: AgentState | undefined;
  let lastMessage: string | undefined;
  let rootSession = false;
  let reporterActive = true;
  let sendInFlight = false;
  let queuedState: QueuedState | undefined;
  let stateRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let stateRetryDelayMs = STATE_RETRY_INITIAL_DELAY_MS;
  let removeBlockedListener: (() => void) | undefined;
  const reporterAbort = new AbortController();

  function clearStateRetryTimer() {
    if (stateRetryTimer) {
      clearTimeout(stateRetryTimer);
      stateRetryTimer = undefined;
    }
  }

  function scheduleStateRetry() {
    if (!reporterActive || stateRetryTimer) {
      return;
    }

    const delay = stateRetryDelayMs;
    stateRetryDelayMs = Math.min(stateRetryDelayMs * 2, STATE_RETRY_MAX_DELAY_MS);
    stateRetryTimer = setTimeout(() => {
      stateRetryTimer = undefined;
      void drainStateQueue();
    }, delay);
    stateRetryTimer.unref?.();
  }

  function queueState(state: AgentState, message?: string): void {
    if (!reporterActive) {
      return;
    }

    queuedState = { state, message, seq: nextReportSeq() };
    if (!sendInFlight && !stateRetryTimer) {
      void drainStateQueue();
    }
  }

  async function drainStateQueue(): Promise<void> {
    if (!reporterActive || sendInFlight) {
      return;
    }

    sendInFlight = true;
    try {
      while (reporterActive && queuedState) {
        const next = queuedState;
        queuedState = undefined;
        const delivered = await sendState(
          next.state,
          next.message,
          next.seq,
          reporterAbort.signal,
        );
        if (!reporterActive) {
          return;
        }
        if (delivered) {
          stateRetryDelayMs = STATE_RETRY_INITIAL_DELAY_MS;
          continue;
        }

        // Keep only the newest desired state. A state queued while this request
        // was in flight supersedes the failed request.
        queuedState ??= next;
        scheduleStateRetry();
        return;
      }
    } finally {
      sendInFlight = false;
      if (reporterActive && queuedState && !stateRetryTimer) {
        void drainStateQueue();
      }
    }
  }

  function stopReporter() {
    if (!reporterActive) {
      return;
    }
    reporterActive = false;
    rootSession = false;
    queuedState = undefined;
    clearStateRetryTimer();
    reporterAbort.abort();
    removeBlockedListener?.();
    removeBlockedListener = undefined;
  }

  function desiredState() {
    if (blockedCount > 0) {
      return { state: "blocked" as const, message: blockedMessage };
    }
    if (agentActive) {
      return { state: "working" as const, message: undefined };
    }
    return { state: "idle" as const, message: undefined };
  }

  function publishState(force = false) {
    const next = desiredState();
    if (!force && next.state === lastState && next.message === lastMessage) {
      return;
    }
    lastState = next.state;
    lastMessage = next.message;
    queueState(next.state, next.message);
  }

  removeBlockedListener = pi.events.on("herdr:blocked", (data) => {
    if (!rootSession) {
      return;
    }
    if (!data?.active) {
      blockedCount = Math.max(0, blockedCount - 1);
      if (blockedCount === 0) {
        blockedMessage = undefined;
      }
      publishState();
      return;
    }

    blockedCount += 1;
    blockedMessage = data.label;
    publishState();
  });

  pi.on("session_start", async (event, ctx) => {
    // TUI only: RPC/JSON/print modes are headless (no PTY herdr can display),
    // and RPC still reports hasUI=true, so mode is the reliable gate.
    if (ctx?.mode !== "tui") {
      return;
    }
    rootSession = true;
    updateSessionRef(ctx);
    await reportSession(event?.reason, reporterAbort.signal);
    // A reload can replace this extension mid-run without emitting another agent_start.
    agentActive = ctx?.isIdle?.() === false;
    publishState(true);
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!rootSession) {
      return;
    }
    updateSessionRef(ctx);
    void reportSession(undefined, reporterAbort.signal);
    agentActive = true;
    publishState();
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!rootSession || ctx?.isIdle?.() !== true) {
      return;
    }

    agentActive = false;
    publishState();
  });

  pi.on("session_shutdown", stopReporter);
}
