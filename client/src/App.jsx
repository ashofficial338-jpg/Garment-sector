import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext.jsx';
import Layout from './layout/Layout.jsx';
import Login from './pages/Login.jsx';
import ChangePassword from './pages/ChangePassword.jsx';
import { Loading } from './components/ui.jsx';

const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const DepartmentDashboard = lazy(() => import('./pages/DepartmentDashboard.jsx'));
const ModulePage = lazy(() => import('./pages/ModulePage.jsx'));
const ControlTower = lazy(() => import('./pages/ControlTower.jsx'));
const Reports = lazy(() => import('./pages/Reports.jsx'));
const Users = lazy(() => import('./pages/admin/Users.jsx'));
const Roles = lazy(() => import('./pages/admin/Roles.jsx'));
const Settings = lazy(() => import('./pages/admin/Settings.jsx'));
const Audit = lazy(() => import('./pages/admin/Audit.jsx'));
const RecycleBin = lazy(() => import('./pages/admin/RecycleBin.jsx'));
const Documents = lazy(() => import('./pages/Documents.jsx'));
const Notifications = lazy(() => import('./pages/Notifications.jsx'));
const Framework = lazy(() => import('./pages/Framework.jsx'));
const Masters = lazy(() => import('./pages/Masters.jsx'));
const Profit = lazy(() => import('./pages/Profit.jsx'));
const StockReports = lazy(() => import('./pages/StockReports.jsx'));

export default function App() {
  const { user, ready } = useAuth();
  if (!ready) return <Loading />;
  if (!user) return <Routes><Route path="*" element={<Login />} /></Routes>;
  if (user.mustChangePassword) return <Routes><Route path="*" element={<ChangePassword />} /></Routes>;

  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="my-dashboard" element={<DepartmentDashboard />} />
          <Route path="control-tower" element={<ControlTower />} />
          <Route path="jobs/:jobNo" element={<ControlTower />} />
          <Route path="m/:key" element={<ModulePage />} />
          <Route path="m/:key/:id" element={<ModulePage />} />
          <Route path="masters" element={<Masters />} />
          <Route path="documents" element={<Documents />} />
          <Route path="reports" element={<Reports />} />
          <Route path="profit" element={<Profit />} />
          <Route path="stock" element={<StockReports />} />
          <Route path="notifications" element={<Notifications />} />
          <Route path="framework" element={<Framework />} />
          <Route path="admin/users" element={<Users />} />
          <Route path="admin/roles" element={<Roles />} />
          <Route path="admin/settings" element={<Settings />} />
          <Route path="admin/audit" element={<Audit />} />
          <Route path="admin/recycle-bin" element={<RecycleBin />} />
          <Route path="change-password" element={<ChangePassword />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
