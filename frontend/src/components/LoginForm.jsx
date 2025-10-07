import { useState } from 'react';

export default function LoginForm({ onSubmit, loading, error }) {
  const [email, setEmail] = useState('amber.lee@example.com');
  const [password, setPassword] = useState('DemoPass123!');

  const handleSubmit = (event) => {
    event.preventDefault();
    onSubmit({ email, password });
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center px-6 py-12">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[28rem] bg-[radial-gradient(circle_at_top,_rgba(226,29,56,0.24),_transparent_65%)]"
      />
      <div className="relative z-10 w-full max-w-lg">
        <div className="glass-card border border-white/60 bg-white/80 p-10 shadow-2xl">
          <div className="flex flex-col gap-3 pb-6 text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-primary/10 text-2xl">
              <span aria-hidden="true">🤖</span>
            </div>
            <h1 className="text-3xl font-semibold text-slate-900">AI Chatbot Demo</h1>
            <p className="text-sm text-slate-600">
              Sign in with a demo account to explore the workspace experience.
            </p>
          </div>
          <form onSubmit={handleSubmit} className="space-y-5">
            <label className="flex flex-col text-left text-sm font-semibold text-slate-600">
              Email
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                className="mt-2 rounded-2xl border border-slate-200 bg-white/90 px-4 py-3 text-sm font-medium text-slate-700 shadow-inner focus:border-brand-primary focus:outline-none focus:ring-2 focus:ring-brand-primary/30"
              />
            </label>
            <label className="flex flex-col text-left text-sm font-semibold text-slate-600">
              Password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                required
                className="mt-2 rounded-2xl border border-slate-200 bg-white/90 px-4 py-3 text-sm font-medium text-slate-700 shadow-inner focus:border-brand-primary focus:outline-none focus:ring-2 focus:ring-brand-primary/30"
              />
            </label>
            {error ? (
              <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-2 text-sm font-medium text-rose-600">
                {error}
              </div>
            ) : null}
            <button
              type="submit"
              disabled={loading}
              className="inline-flex w-full items-center justify-center rounded-2xl bg-brand-primary px-4 py-3 text-sm font-semibold text-white shadow-md transition hover:bg-brand-primary/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? 'Signing in…' : 'Sign In'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
