import { useState } from 'react';
import { AppStateProvider, useAppState } from './state/AppState';
import { AuthProvider, useAuth } from './state/AuthState';
import AuthScreen from './components/AuthScreen';
import Sidebar from './components/Sidebar';
import ChatPanel from './components/ChatPanel';
import SchemaExplorer from './components/SchemaExplorer';
import HealthBadge from './components/HealthBadge';
import InsightsPanel from './components/InsightsPanel';
import ActionsPanel from './components/ActionsPanel';
import GovernancePanel from './components/GovernancePanel';
import AdminPanel from './components/AdminPanel';
import CommandCenter from './components/CommandCenter';
import DashboardPanel from './components/DashboardPanel';
import ActivityPanel from './components/ActivityPanel';
import CatalogPanel from './components/CatalogPanel';
import SettingsPanel from './components/SettingsPanel';
import './App.css';

function MainArea() {
  const { activeDataset } = useAppState();
  const { user } = useAuth();
  const [tab, setTab] = useState('command');
  const [traceFocus, setTraceFocus] = useState(null);
  const [pendingQuestion, setPendingQuestion] = useState(null);
  const role = user?.role;
  const canActions = ['admin', 'manager', 'analyst', 'user'].includes(role);
  const canGovern = ['admin', 'manager'].includes(role);
  const tabs = [
    ['command', 'Command Center'], ['chat', 'Chat'], ['dashboard', 'Dashboard'], ['insights', 'Data Quality'], ['catalog', 'Catalog'], ['schema', 'Schema'], ['activity', 'AI Activity'],
    ...(canActions ? [['actions', 'Actions']] : []),
    ...(canGovern ? [['governance', 'Governance']] : []),
    ...(role === 'admin' ? [['admin', 'Admin']] : []),
    ['settings', 'Settings'],
  ];
  const askFromPanel = (q) => { setPendingQuestion(q); setTab('chat'); };

  return (
    <main className="main-area">
      <header className="topbar">
        <div className="topbar-title">
          {activeDataset ? activeDataset.name : 'CogniCore'}
        </div>
        <nav className="tab-bar">
          {tabs.map(([key, label]) => (
            <button key={key} className={`tab-btn ${tab === key ? 'tab-btn-active' : ''}`} onClick={() => setTab(key)}>{label}</button>
          ))}
        </nav>
        <HealthBadge />
      </header>

      <div className="tab-content">
        {tab === 'command' && <CommandCenter onAsk={askFromPanel} onOpenTab={(t, id) => { if (id) setTraceFocus(id); setTab(t); }} />}
        {tab === 'dashboard' && <DashboardPanel />}
        {tab === 'catalog' && <CatalogPanel />}
        {tab === 'activity' && <ActivityPanel focusId={traceFocus} />}
        {tab === 'settings' && <SettingsPanel />}
        {tab === 'chat' && <ChatPanel onOpenActions={() => setTab('actions')} onOpenTrace={(id) => { setTraceFocus(id); setTab('activity'); }} pendingQuestion={pendingQuestion} onPendingConsumed={() => setPendingQuestion(null)} />}
        {tab === 'insights' && <InsightsPanel onAsk={askFromPanel} />}
        {tab === 'schema' && <SchemaExplorer />}
        {tab === 'actions' && canActions && <ActionsPanel />}
        {tab === 'governance' && canGovern && <GovernancePanel />}
        {tab === 'admin' && role === 'admin' && <AdminPanel />}
      </div>
    </main>
  );
}

function AuthedApp() {
  return (
    <AppStateProvider>
      <div className="app-shell">
        <Sidebar />
        <MainArea />
      </div>
    </AppStateProvider>
  );
}

function Root() {
  const { user, loading } = useAuth();

  if (loading) {
    return <div className="empty-state" style={{ height: '100vh' }}><div className="empty-state-title">Loading…</div></div>;
  }
  if (!user) {
    return <AuthScreen />;
  }
  return <AuthedApp />;
}

export default function App() {
  return (
    <AuthProvider>
      <Root />
    </AuthProvider>
  );
}
