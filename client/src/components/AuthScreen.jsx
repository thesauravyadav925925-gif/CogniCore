import { useState } from 'react';
import { useAuth } from '../state/AuthState';

export default function AuthScreen() {
  const { login, register, error } = useAuth();
  const [mode, setMode] = useState('login'); // 'login' | 'register'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    if (mode === 'login') await login(email, password);
    else await register(email, password, name);
    setSubmitting(false);
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="brand-mark">CC</span>
          <div className="brand-name">CogniCore</div>
        </div>
        <div className="auth-subtitle">
          {mode === 'login' ? 'Sign in to your workspace' : 'Create your account'}
        </div>

        <form className="auth-form" onSubmit={handleSubmit}>
          {mode === 'register' && (
            <input
              className="connect-input"
              placeholder="Name (optional)"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
          <input
            className="connect-input"
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <input
            className="connect-input"
            type="password"
            placeholder="Password (min 8 characters)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
          />
          {error && <div className="sidebar-error">{error}</div>}
          <button className="connect-submit" type="submit" disabled={submitting}>
            {submitting ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <button className="auth-switch" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
          {mode === 'login' ? "Don't have an account? Register" : 'Already have an account? Sign in'}
        </button>

        {mode === 'register' && (
          <div className="auth-hint">The first person to register becomes the workspace admin.</div>
        )}
      </div>
    </div>
  );
}
