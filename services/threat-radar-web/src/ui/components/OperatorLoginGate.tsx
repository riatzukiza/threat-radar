import { useState } from "react";

export interface OperatorLoginGateProps {
  readonly onLogin: (identifier: string, appPassword: string, serviceUrl?: string) => Promise<void>;
  readonly error?: string | null;
}

export function OperatorLoginGate({ onLogin, error }: OperatorLoginGateProps): JSX.Element {
  const [identifier, setIdentifier] = useState("");
  const [appPassword, setAppPassword] = useState("");
  const [serviceUrl, setServiceUrl] = useState("https://bsky.social");
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  return (
    <div className="operator-login-shell">
      <div className="operator-login-card">
        <div className="operator-login-eyebrow">Mission Control</div>
        <h1>Threat Radar Operator Access</h1>
        <p>
          Sign in with your Bluesky account for now. This is the first operator shell:
          firehose rules, semantic feed previews, draft editing, and posting from one place.
        </p>
        <form
          className="operator-login-form"
          onSubmit={(event) => {
            event.preventDefault();
            setSubmitting(true);
            setLocalError(null);
            void onLogin(identifier, appPassword, serviceUrl)
              .catch((err: unknown) => {
                setLocalError(err instanceof Error ? err.message : "Login failed");
              })
              .finally(() => setSubmitting(false));
          }}
        >
          <label>
            <span>Handle / DID</span>
            <input value={identifier} onChange={(event) => setIdentifier(event.target.value)} placeholder="you.bsky.social" required />
          </label>
          <label>
            <span>App password</span>
            <input type="password" value={appPassword} onChange={(event) => setAppPassword(event.target.value)} placeholder="xxxx-xxxx-xxxx-xxxx" required />
          </label>
          <label>
            <span>Service URL</span>
            <input value={serviceUrl} onChange={(event) => setServiceUrl(event.target.value)} placeholder="https://bsky.social" />
          </label>
          {(localError || error) && <div className="operator-login-error">{localError || error}</div>}
          <button className="operator-button operator-button-primary" type="submit" disabled={submitting}>
            {submitting ? "Signing in…" : "Enter mission control"}
          </button>
        </form>
      </div>
    </div>
  );
}
