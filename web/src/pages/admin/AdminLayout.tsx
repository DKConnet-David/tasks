import { Link, NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../../auth";

export function AdminLayout() {
  const { me, logout } = useAuth();
  return (
    <div className="admin-container stack">
      <header className="row" style={{ justifyContent: "space-between" }}>
        <div className="row" style={{ gap: "1rem" }}>
          <strong>Task Upater — Admin</strong>
          <nav className="row" style={{ gap: "0.75rem" }}>
            <NavLink to="/admin" end>Submissions</NavLink>
            <NavLink to="/admin/manual">Manual entry</NavLink>
            <NavLink to="/admin/whatsapp">WhatsApp</NavLink>
          </nav>
        </div>
        <div className="row" style={{ gap: "0.5rem" }}>
          <span className="muted">{me?.splynx_login}</span>
          <Link to="/">Tech view</Link>
          <button className="secondary" onClick={() => logout()}>Sign out</button>
        </div>
      </header>
      <Outlet />
    </div>
  );
}
