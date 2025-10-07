import { useEffect, useMemo, useState } from 'react';
import {
  fetchConfig,
  fetchModels,
  fetchSessions,
  createSession,
  updateSession,
  deleteSession,
  fetchMessages,
  sendMessage,
  editMessage,
  listRuns,
  getRun,
  runTool
} from '../api/index.js';

const MAX_FILE_SIZE_MB = 5;

function formatDate(value) {
  return new Date(value).toLocaleString();
}

function getRoleLabel(role) {
  switch (role) {
    case 'user':
      return 'You';
    case 'assistant':
      return 'Assistant';
    case 'tool':
      return 'Tool';
    case 'system':
      return 'System';
    default:
      return role;
  }
}

function getAvatarGlyph(role, user) {
  if (role === 'user') {
    const source = user?.full_name || user?.email || 'You';
    return source.trim().slice(0, 1).toUpperCase();
  }
  if (role === 'assistant') {
    return 'AI';
  }
  if (role === 'tool') {
    return '🔧';
  }
  return 'ℹ️';
}

export default function Workspace({ user, onLogout }) {
  const [config, setConfig] = useState(null);
  const [models, setModels] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [composerText, setComposerText] = useState('');
  const [composerFiles, setComposerFiles] = useState([]);
  const [editingMessageId, setEditingMessageId] = useState(null);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [sending, setSending] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [runs, setRuns] = useState([]);
  const [selectedRun, setSelectedRun] = useState(null);
  const [selectedRunDetails, setSelectedRunDetails] = useState(null);
  const [toolServer, setToolServer] = useState('');
  const [toolName, setToolName] = useState('');
  const [toolArgs, setToolArgs] = useState('{}');
  const [toolResult, setToolResult] = useState(null);
  const [statusMessage, setStatusMessage] = useState(null);

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) || null,
    [sessions, activeSessionId]
  );
  const personaOptions = useMemo(() => config?.personas?.personas || [], [config]);

  useEffect(() => {
    const bootstrap = async () => {
      const [cfg, mdl] = await Promise.all([fetchConfig(), fetchModels()]);
      setConfig(cfg);
      setModels(mdl);
      await loadSessions();
    };
    bootstrap().catch((error) => console.error('Failed to bootstrap workspace', error));
  }, []);

  useEffect(() => {
    if (!activeSessionId) return;
    loadMessages(activeSessionId);
    loadRuns(activeSessionId);
  }, [activeSessionId]);

  const loadSessions = async () => {
    setLoadingSessions(true);
    try {
      const list = await fetchSessions();
      setSessions(list);
      if (!activeSessionId && list.length) {
        setActiveSessionId(list[0].id);
      }
    } finally {
      setLoadingSessions(false);
    }
  };

  const loadMessages = async (sessionId) => {
    const data = await fetchMessages(sessionId);
    setMessages(data);
  };

  const loadRuns = async (sessionId) => {
    const data = await listRuns(sessionId);
    setRuns(data);
    if (data.length) {
      setSelectedRun(data[0]);
      const detail = await getRun(data[0].id);
      setSelectedRunDetails(detail);
    } else {
      setSelectedRun(null);
      setSelectedRunDetails(null);
    }
  };

  const handleSelectSession = async (sessionId) => {
    setActiveSessionId(sessionId);
  };

  const handleCreateSession = async () => {
    const created = await createSession({});
    await loadSessions();
    setActiveSessionId(created.id);
    setMessages([]);
  };

  const handleDeleteSession = async (sessionId) => {
    await deleteSession(sessionId);
    const remaining = sessions.filter((session) => session.id !== sessionId);
    setSessions(remaining);
    if (remaining.length) {
      setActiveSessionId(remaining[0].id);
    } else {
      setActiveSessionId(null);
      setMessages([]);
    }
  };

  const handleRenameSession = async (sessionId) => {
    const current = sessions.find((session) => session.id === sessionId);
    const nextTitle = window.prompt('Rename chat', current?.title || '');
    if (!nextTitle) return;
    const updated = await updateSession(sessionId, { title: nextTitle });
    setSessions((prev) => prev.map((session) => (session.id === sessionId ? updated : session)));
  };

  const handleSessionFieldChange = async (sessionId, patch) => {
    const updated = await updateSession(sessionId, patch);
    setSessions((prev) => prev.map((session) => (session.id === sessionId ? updated : session)));
  };

  const handleSendMessage = async () => {
    if (!activeSessionId || !composerText.trim()) return;
    setSending(true);
    try {
      const filesOverLimit = Array.from(composerFiles || []).find((file) => file.size > MAX_FILE_SIZE_MB * 1024 * 1024);
      if (filesOverLimit) {
        setStatusMessage(`File "${filesOverLimit.name}" exceeds ${MAX_FILE_SIZE_MB} MB limit.`);
        return;
      }
      if (editingMessageId) {
        await editMessage(activeSessionId, editingMessageId, composerText.trim());
      } else {
        await sendMessage(activeSessionId, composerText.trim(), composerFiles);
      }
      setComposerText('');
      setComposerFiles([]);
      setEditingMessageId(null);
      setStatusMessage(null);
      await loadMessages(activeSessionId);
      await loadRuns(activeSessionId);
    } catch (error) {
      console.error(error);
      setStatusMessage('Failed to send message. Check console for details.');
    } finally {
      setSending(false);
    }
  };

  const handleStartEditing = () => {
    const latestUserMessage = [...messages]
      .filter((message) => message.role === 'user')
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
    if (!latestUserMessage) return;
    setComposerText(latestUserMessage.content);
    setEditingMessageId(latestUserMessage.id);
    setStatusMessage('Editing your latest message. Send to re-run or cancel to discard.');
  };

  const handleCancelEditing = () => {
    setEditingMessageId(null);
    setStatusMessage(null);
    setComposerText('');
  };

  const handleFileChange = (event) => {
    setComposerFiles(event.target.files);
  };

  const handleSelectRun = async (run) => {
    setSelectedRun(run);
    const detail = await getRun(run.id);
    setSelectedRunDetails(detail);
  };

  const handleExecuteTool = async () => {
    if (!activeSessionId || !toolServer || !toolName) {
      setStatusMessage('Select a server and tool before running.');
      return;
    }
    let argsObject = {};
    try {
      argsObject = JSON.parse(toolArgs || '{}');
    } catch (error) {
      setStatusMessage('Arguments must be valid JSON.');
      return;
    }
    try {
      const result = await runTool(activeSessionId, {
        server_name: toolServer,
        tool_name: toolName,
        arguments: argsObject
      });
      setToolResult(result.output);
      setStatusMessage('Tool executed successfully.');
      await loadRuns(activeSessionId);
    } catch (error) {
      console.error(error);
      setStatusMessage('Tool execution failed. See console for details.');
    }
  };

  const availableServers = useMemo(() => config?.mcp?.servers || [], [config]);
  const hiddenMessageIds = useMemo(() => {
    const ids = new Set();
    messages.forEach((message) => {
      if (message.edited_from_message_id) {
        ids.add(message.edited_from_message_id);
      }
    });
    return ids;
  }, [messages]);
  const visibleMessages = useMemo(
    () => messages.filter((message) => !hiddenMessageIds.has(message.id)),
    [messages, hiddenMessageIds]
  );

  return (
    <div className={`app-shell ${drawerOpen ? 'drawer-open' : ''}`}>
      <aside className="sidebar">
        <div className="sidebar-header">
          <button className="primary-btn" onClick={handleCreateSession}>
            + New Chat
          </button>
        </div>
        <div className="sidebar-body">
          <div className="sidebar-section">
            <h2 className="sidebar-title">Chats</h2>
            <div className="session-list">
              {loadingSessions && <div className="muted">Loading sessions…</div>}
              {!loadingSessions && sessions.length === 0 && <div className="muted">No sessions yet.</div>}
              {sessions.map((session) => (
                <div
                  key={session.id}
                  className={`session-item ${session.id === activeSessionId ? 'active' : ''}`}
                  onClick={() => handleSelectSession(session.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      handleSelectSession(session.id);
                    }
                  }}
                >
                  <div>
                    <div className="session-title">{session.title}</div>
                    <div className="session-meta">{formatDate(session.created_at)}</div>
                  </div>
                  <div className="session-actions">
                    <button
                      className="icon-btn"
                      onClick={(event) => {
                        event.stopPropagation();
                        handleRenameSession(session.id);
                      }}
                      aria-label="Rename session"
                    >
                      ✎
                    </button>
                    <button
                      className="icon-btn"
                      onClick={(event) => {
                        event.stopPropagation();
                        handleDeleteSession(session.id);
                      }}
                      aria-label="Delete session"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="sidebar-footer">
            <div className="user-pill">
              <span>{user?.full_name || user?.email}</span>
              <button className="icon-btn" onClick={onLogout} title="Logout">
                ⎋
              </button>
            </div>
          </div>
        </div>
      </aside>

      <main className="chat-panel">
        <header className="chat-header">
          <div className="chat-header-left">
            <div className="chat-title">
              <div className="session-pill">{activeSession ? 'Active Chat' : 'Welcome'}</div>
              <h1>{activeSession?.title || 'Select or create a chat'}</h1>
            </div>
            <div className="chat-toolbar">
              <div className="toolbar-group">
                <label>
                  Model
                  <select
                    value={activeSession?.model_id || ''}
                    onChange={(event) => handleSessionFieldChange(activeSessionId, { model_id: event.target.value })}
                    disabled={!activeSession}
                  >
                    {models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.id}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Persona
                  <select
                    value={activeSession?.persona_id || ''}
                    onChange={(event) => handleSessionFieldChange(activeSessionId, { persona_id: event.target.value })}
                    disabled={!activeSession}
                  >
                    {personaOptions.map((persona) => (
                      <option key={persona.id} value={persona.id}>
                        {persona.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="toolbar-group">
                <label className="toggle-label">
                  <input
                    type="checkbox"
                    checked={activeSession?.rag_enabled || false}
                    onChange={(event) => handleSessionFieldChange(activeSessionId, { rag_enabled: event.target.checked })}
                    disabled={!activeSession}
                  />
                  RAG Enabled
                </label>
                <label className="toggle-label">
                  <input
                    type="checkbox"
                    checked={activeSession?.streaming_enabled || false}
                    onChange={(event) => handleSessionFieldChange(activeSessionId, { streaming_enabled: event.target.checked })}
                    disabled={!activeSession}
                  />
                  Streaming
                </label>
              </div>
            </div>
          </div>
          <div className="chat-header-right">
            <button className="secondary-btn" onClick={() => setDrawerOpen((prev) => !prev)}>
              {drawerOpen ? 'Close Activity' : 'Open Activity'}
            </button>
          </div>
        </header>

        <section className="control-surfaces">
          <div className="panel">
            <div className="panel-header">
              <h3>MCP Servers</h3>
              <span className="muted">Toggle and run tools for the active chat.</span>
            </div>
            <div className="mcp-grid">
              {availableServers.map((server) => (
                <label key={server.name} className="toggle-label">
                  <input
                    type="checkbox"
                    checked={activeSession?.enabled_mcp_servers?.includes(server.name) || false}
                    onChange={(event) => {
                      const enabled = new Set(activeSession?.enabled_mcp_servers || []);
                      if (event.target.checked) {
                        enabled.add(server.name);
                      } else {
                        enabled.delete(server.name);
                      }
                      handleSessionFieldChange(activeSessionId, { enabled_mcp_servers: Array.from(enabled) });
                    }}
                    disabled={!activeSession}
                  />
                  {server.name} <span className="muted">({server.transport})</span>
                </label>
              ))}
            </div>
            <div className="tool-runner">
              <div className="tool-row">
                <label>
                  Server
                  <select value={toolServer} onChange={(event) => setToolServer(event.target.value)}>
                    <option value="">Select server</option>
                    {(activeSession?.enabled_mcp_servers || []).map((serverName) => (
                      <option key={serverName} value={serverName}>
                        {serverName}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Tool
                  <input
                    type="text"
                    value={toolName}
                    onChange={(event) => setToolName(event.target.value)}
                    placeholder="list_directory"
                  />
                </label>
              </div>
              <label>
                Arguments (JSON)
                <textarea
                  rows={3}
                  value={toolArgs}
                  onChange={(event) => setToolArgs(event.target.value)}
                  placeholder='{"path": "."}'
                />
              </label>
              <div className="tool-actions">
                <button className="secondary-btn" onClick={handleExecuteTool} disabled={!activeSession}>
                  Run Tool
                </button>
              </div>
              {toolResult && (
                <pre className="tool-output">{JSON.stringify(toolResult, null, 2)}</pre>
              )}
            </div>
          </div>
        </section>

        <section className="messages" aria-live="polite">
          {visibleMessages.length === 0 && (
            <div className="empty-state">
              <div className="empty-illustration">💬</div>
              <h3>Start the conversation</h3>
              <p className="muted">Send a prompt to see model responses, trace tools, and RAG activity.</p>
            </div>
          )}
          {visibleMessages.map((message) => (
            <article key={message.id} className={`message ${message.role}`}>
              <div className="message-avatar" aria-hidden="true">
                {getAvatarGlyph(message.role, user)}
              </div>
              <div className="message-body">
                <header className="message-header">
                  <span className="message-author">{getRoleLabel(message.role)}</span>
                  <span className="timestamp">{formatDate(message.created_at)}</span>
                  {message.edited_from_message_id && <span className="pill">Edited</span>}
                </header>
                <div className="message-content">{message.content}</div>
              </div>
            </article>
          ))}
        </section>

        <footer className="composer">
          {statusMessage && <div className="status-banner">{statusMessage}</div>}
          <div className="composer-shell">
            <textarea
              value={composerText}
              onChange={(event) => setComposerText(event.target.value)}
              placeholder="Send a message..."
              rows={3}
            />
            <div className="composer-footer">
              <div className="composer-left">
                <label className="upload-btn">
                  <span>＋ Attach</span>
                  <input type="file" multiple onChange={handleFileChange} />
                </label>
                {!editingMessageId ? (
                  <button className="ghost-btn" onClick={handleStartEditing} disabled={!messages.length}>
                    Edit Last Message
                  </button>
                ) : (
                  <button className="ghost-btn" onClick={handleCancelEditing}>
                    Cancel Edit
                  </button>
                )}
              </div>
              <button className="primary-btn" onClick={handleSendMessage} disabled={sending || !activeSessionId}>
                {sending ? 'Sending…' : editingMessageId ? 'Resend' : 'Send'}
              </button>
            </div>
          </div>
        </footer>
      </main>

      <aside className="activity-drawer">
        <div className="drawer-header">
          <h2>Internal Activity</h2>
        </div>
        <div className="drawer-content">
          <div className="run-list">
            {runs.map((run) => (
              <div
                key={run.id}
                className={`run-item ${selectedRun?.id === run.id ? 'active' : ''}`}
                onClick={() => handleSelectRun(run)}
              >
                <div className="run-title">{run.status.toUpperCase()} · {run.model_id || 'model'}</div>
                <div className="run-meta">{formatDate(run.started_at)}</div>
              </div>
            ))}
          </div>
          {selectedRunDetails ? (
            <div className="run-detail">
              <h3>Run Timeline</h3>
              {selectedRunDetails.steps.map((step) => (
                <div key={step.id} className="run-step">
                  <div className="step-meta">
                    <span className="pill">{step.type}</span>
                    <span>{formatDate(step.ts)}</span>
                  </div>
                  {step.label && <div className="step-label">{step.label}</div>}
                  {step.input_json && (
                    <pre className="step-json">{JSON.stringify(step.input_json, null, 2)}</pre>
                  )}
                  {step.output_json && (
                    <pre className="step-json muted">{JSON.stringify(step.output_json, null, 2)}</pre>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="muted">Select a run to inspect details.</div>
          )}
        </div>
      </aside>
    </div>
  );
}
