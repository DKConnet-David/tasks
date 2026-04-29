import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth";
import { Login } from "./pages/Login";
import { TaskLookup } from "./pages/TaskLookup";
import { TaskDetail } from "./pages/TaskDetail";
import { Submitting } from "./pages/Submitting";
import { AdminLayout } from "./pages/admin/AdminLayout";
import { SubmissionsList } from "./pages/admin/SubmissionsList";
import { SubmissionDetail } from "./pages/admin/SubmissionDetail";
import { ManualSubmit } from "./pages/admin/ManualSubmit";
import { WhatsAppPanel } from "./pages/admin/WhatsAppPanel";

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<Login />} />

        <Route path="/" element={<RequireAuth><TaskLookup /></RequireAuth>} />
        <Route path="/tasks/:id" element={<RequireAuth><TaskDetail /></RequireAuth>} />
        <Route path="/submitting/:id" element={<RequireAuth><Submitting /></RequireAuth>} />

        <Route path="/admin" element={<RequireAdmin><AdminLayout /></RequireAdmin>}>
          <Route index element={<SubmissionsList />} />
          <Route path="submissions/:id" element={<SubmissionDetail />} />
          <Route path="manual" element={<ManualSubmit />} />
          <Route path="whatsapp" element={<WhatsAppPanel />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}

function RequireAuth({ children }: { children: React.ReactElement }) {
  const { me, loading } = useAuth();
  if (loading) return <Loading />;
  if (!me) return <Navigate to="/login" replace />;
  return children;
}

function RequireAdmin({ children }: { children: React.ReactElement }) {
  const { me, loading } = useAuth();
  if (loading) return <Loading />;
  if (!me) return <Navigate to="/login" replace />;
  if (!me.is_admin) return <Navigate to="/" replace />;
  return children;
}

function Loading() {
  return <div className="container muted">Loading…</div>;
}
