import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";

export function TaskLookup() {
  const [taskId, setTaskId] = useState("");
  const nav = useNavigate();
  const { me, logout } = useAuth();

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const id = Number.parseInt(taskId.trim(), 10);
    if (!Number.isFinite(id)) return;
    nav(`/tasks/${id}`);
  }

  return (
    <div className="container stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong>{me?.app_login}</strong>
        <div className="row" style={{ gap: "0.5rem" }}>
          {me?.is_admin ? <Link to="/admin">Admin</Link> : null}
          <button className="secondary" onClick={() => logout()}>Sign out</button>
        </div>
      </div>
      <h1>Find a task</h1>
      <form className="stack" onSubmit={onSubmit}>
        <input
          inputMode="numeric"
          placeholder="Task ID"
          value={taskId}
          onChange={(e) => setTaskId(e.target.value)}
          autoFocus
        />
        <button>Open task</button>
      </form>
    </div>
  );
}
