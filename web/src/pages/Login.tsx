import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, api } from "../api";
import { useAuth } from "../auth";

export function Login() {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const { refresh } = useAuth();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.post("/auth/login", { login, password });
      await refresh();
      nav("/", { replace: true });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setError("Invalid credentials");
      else setError("Login failed — please try again");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="container">
      <h1>Sign in</h1>
      <form className="stack" onSubmit={onSubmit}>
        <label className="stack" style={{ gap: 4 }}>
          <span className="muted">Splynx login</span>
          <input
            value={login}
            onChange={(e) => setLogin(e.target.value)}
            autoComplete="username"
            required
          />
        </label>
        <label className="stack" style={{ gap: 4 }}>
          <span className="muted">Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error ? <div className="danger">{error}</div> : null}
        <button disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
    </div>
  );
}
