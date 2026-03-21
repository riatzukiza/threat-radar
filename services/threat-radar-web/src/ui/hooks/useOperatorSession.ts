import { useCallback, useEffect, useState } from "react";

import { fetchOperatorSession, loginOperator, logoutOperator } from "../../api/client";
import type { OperatorSession } from "../../api/types";

const STORAGE_KEY = "threat-radar-operator-session";

export interface OperatorAuthState {
  session: OperatorSession | null;
  sessionId: string | null;
  loading: boolean;
  error: string | null;
  login: (identifier: string, appPassword: string, serviceUrl?: string) => Promise<void>;
  logout: () => Promise<void>;
}

export function useOperatorSession(apiUrl: string): OperatorAuthState {
  const [session, setSession] = useState<OperatorSession | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (!saved) {
      setLoading(false);
      return;
    }
    setSessionId(saved);
    void fetchOperatorSession(apiUrl, saved)
      .then((nextSession) => {
        setSession(nextSession);
        setError(null);
      })
      .catch(() => {
        window.localStorage.removeItem(STORAGE_KEY);
        setSessionId(null);
        setSession(null);
      })
      .finally(() => setLoading(false));
  }, [apiUrl]);

  const login = useCallback(async (identifier: string, appPassword: string, serviceUrl?: string) => {
    const nextSession = await loginOperator(apiUrl, identifier, appPassword, serviceUrl);
    window.localStorage.setItem(STORAGE_KEY, nextSession.id);
    setSession(nextSession);
    setSessionId(nextSession.id);
    setError(null);
  }, [apiUrl]);

  const logout = useCallback(async () => {
    if (sessionId) {
      try {
        await logoutOperator(apiUrl, sessionId);
      } catch {
        // best effort
      }
    }
    window.localStorage.removeItem(STORAGE_KEY);
    setSessionId(null);
    setSession(null);
    setError(null);
  }, [apiUrl, sessionId]);

  return { session, sessionId, loading, error, login, logout };
}
