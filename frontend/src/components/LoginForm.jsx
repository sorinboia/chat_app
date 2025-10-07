import { useState } from 'react';

export default function LoginForm({ onSubmit, loading, error }) {
  const [email, setEmail] = useState('amber.lee@example.com');
  const [password, setPassword] = useState('DemoPass123!');

  const handleSubmit = (event) => {
    event.preventDefault();
    onSubmit({ email, password });
  };

  return (
    <div className="login-wrapper">
      <div className="login-card">
        <div className="brand">
          <span className="brand-dot" />
          <h1>AI Chatbot Demo</h1>
          <p>Sign in with a demo account to explore the workspace.</p>
        </div>
        <form onSubmit={handleSubmit} className="login-form">
          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              required
            />
          </label>
          {error ? <div className="form-error">{error}</div> : null}
          <button type="submit" disabled={loading} className="primary-btn">
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}
