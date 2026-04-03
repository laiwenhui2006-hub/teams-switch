export type CopilotSessionState = {
  requestCount: number;
  lastUpdatedAt: number;
};

const sessionStates = new Map<string, CopilotSessionState>();

export function getCopilotSessionState(sessionID: string): CopilotSessionState {
  const state = sessionStates.get(sessionID);
  if (state) {
    return { ...state };
  }
  return {
    requestCount: 0,
    lastUpdatedAt: Date.now(),
  };
}

export function incrementCopilotRequestCount(sessionID: string): void {
  const state = sessionStates.get(sessionID) || { requestCount: 0, lastUpdatedAt: Date.now() };
  state.requestCount += 1;
  state.lastUpdatedAt = Date.now();
  sessionStates.set(sessionID, state);
}

export function clearCopilotSessionState(sessionID: string): void {
  sessionStates.delete(sessionID);
}
