import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const [activityVisible, setActivityVisible] = useState(false);
  const [activityWidth, setActivityWidth] = useState(380);
  const [activeResizer, setActiveResizer] = useState(null);
  const [runs, setRuns] = useState([]);
  const [selectedRun, setSelectedRun] = useState(null);
  const [selectedRunDetails, setSelectedRunDetails] = useState(null);
  const [toolServer, setToolServer] = useState('');
  const [toolName, setToolName] = useState('');
  const [toolArgs, setToolArgs] = useState('{}');
  const [toolResult, setToolResult] = useState(null);
  const [statusMessage, setStatusMessage] = useState(null);
  const [isMcpModalOpen, setIsMcpModalOpen] = useState(false);
  const appShellRef = useRef(null);
  const sendAbortControllerRef = useRef(null);
  const messagesContainerRef = useRef(null);
  const previousMessageCountRef = useRef(0);

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) || null,
    [sessions, activeSessionId]
  );
  const personaOptions = useMemo(() => config?.personas?.personas || [], [config]);
  const appShellClasses = useMemo(() => {
    let classes = 'app-shell';
    if (sidebarHidden) classes += ' sidebar-collapsed';
    if (!activityVisible) classes += ' activity-hidden';
    return classes;
  }, [activityVisible, sidebarHidden]);
  const shellStyle = useMemo(
    () => ({
      gridTemplateColumns: `${sidebarHidden ? '0px' : `${sidebarWidth}px`} 1fr ${activityVisible ? `${activityWidth}px` : '0px'}`
    }),
    [sidebarHidden, sidebarWidth, activityVisible, activityWidth]
  );

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

  useEffect(() => {
    if (!isMcpModalOpen) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setIsMcpModalOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isMcpModalOpen]);

  useEffect(() => {
    setIsMcpModalOpen(false);
  }, [activeSessionId]);

  const scrollMessagesToBottom = useCallback(
    (behavior = 'auto') => {
      const container = messagesContainerRef.current;
      if (!container) return;
      const performScroll = () => {
        container.scrollTo({ top: container.scrollHeight, behavior });
      };
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(performScroll);
      } else {
        performScroll();
      }
    },
    []
  );

  useEffect(() => {
    previousMessageCountRef.current = 0;
  }, [activeSessionId]);

  useEffect(() => {
    if (!messages.length) {
      previousMessageCountRef.current = 0;
      return;
    }
    const behavior = previousMessageCountRef.current ? 'smooth' : 'auto';
    scrollMessagesToBottom(behavior);
    previousMessageCountRef.current = messages.length;
  }, [messages, scrollMessagesToBottom]);

  useEffect(() => {
    if (!activeResizer) return undefined;

    const handlePointerMove = (event) => {
      event.preventDefault();
      if (activeResizer === 'left') {
        const minWidth = 220;
        const maxWidth = 520;
        const nextWidth = Math.min(Math.max(event.clientX, minWidth), maxWidth);
        setSidebarWidth(nextWidth);
      } else if (activeResizer === 'right') {
        const shell = appShellRef.current;
        if (!shell) return;
        const rect = shell.getBoundingClientRect();
        const minWidth = 200;
        const maxWidth = 1400;
        const distance = rect.right - event.clientX;
        const nextWidth = Math.min(Math.max(distance, minWidth), maxWidth);
        setActivityWidth(nextWidth);
      }
    };

    const handlePointerUp = () => {
      setActiveResizer(null);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    document.body.classList.add('is-resizing');

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      document.body.classList.remove('is-resizing');
    };
  }, [activeResizer]);

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

  const handleSidebarResizeStart = useCallback((event) => {
    event.preventDefault();
    event.stopPropagation();
    setActiveResizer('left');
  }, []);

  const handleActivityResizeStart = useCallback((event) => {
    event.preventDefault();
    event.stopPropagation();
    setActiveResizer('right');
  }, []);

  const toggleSidebarVisibility = useCallback(() => {
    setSidebarHidden((prev) => !prev);
  }, []);

  const toggleActivityVisibility = useCallback(() => {
    setActivityVisible((prev) => !prev);
  }, []);

  const handleOpenMcpModal = useCallback(() => {
    if (!activeSession) return;
    setIsMcpModalOpen(true);
  }, [activeSession]);

  const handleCloseMcpModal = useCallback(() => {
    setIsMcpModalOpen(false);
  }, []);

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
    if (!activeSessionId || !composerText.trim() || sending) return;
    setSending(true);
    try {
      setStatusMessage(null);
      const filesOverLimit = Array.from(composerFiles || []).find((file) => file.size > MAX_FILE_SIZE_MB * 1024 * 1024);
      if (filesOverLimit) {
        setStatusMessage(`File "${filesOverLimit.name}" exceeds ${MAX_FILE_SIZE_MB} MB limit.`);
        return;
      }
      const controller = new AbortController();
      sendAbortControllerRef.current = controller;
      if (editingMessageId) {
        await editMessage(activeSessionId, editingMessageId, composerText.trim(), { signal: controller.signal });
      } else {
        await sendMessage(activeSessionId, composerText.trim(), composerFiles, { signal: controller.signal });
      }
      setComposerText('');
      setComposerFiles([]);
      setEditingMessageId(null);
      setStatusMessage(null);
      await loadMessages(activeSessionId);
      await loadRuns(activeSessionId);
    } catch (error) {
      if (error?.name === 'CanceledError' || error?.code === 'ERR_CANCELED') {
        setStatusMessage('Message sending canceled.');
      } else {
        console.error(error);
        setStatusMessage('Failed to send message. Check console for details.');
      }
    } finally {
      if (sendAbortControllerRef.current) {
        sendAbortControllerRef.current = null;
      }
      setSending(false);
    }
  };

  const handleCancelSend = () => {
    const controller = sendAbortControllerRef.current;
    if (controller) {
      controller.abort();
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

  const handleComposerKeyDown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!sending) {
        handleSendMessage();
      }
    }
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
    <div ref={appShellRef} className={appShellClasses} style={shellStyle}>
      <aside className="sidebar" aria-hidden={sidebarHidden}>
        <div className="sidebar-header">
          <button className="primary-btn" onClick={handleCreateSession}>
            + New Chat
          </button>
          <button
            className="ghost-btn sidebar-toggle"
            onClick={toggleSidebarVisibility}
            aria-label={sidebarHidden ? 'Show chat list' : 'Hide chat list'}
          >
            {sidebarHidden ? '⟩' : '⟨'}
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
                  tabIndex={sidebarHidden ? -1 : 0}
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
        {!sidebarHidden && (
          <div
            className="panel-resizer sidebar-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize chat list"
            onPointerDown={handleSidebarResizeStart}
          />
        )}
      </aside>

      <main className="chat-panel" aria-busy={sending}>
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
                    disabled={!activeSession || sending}
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
                    disabled={!activeSession || sending}
                  >
                    {personaOptions.map((persona) => (
                      <option key={persona.id} value={persona.id}>
                        {persona.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="secondary-btn" onClick={handleOpenMcpModal} disabled={!activeSession}>
                  MCP Servers
                </button>
              </div>
              <div className="toolbar-group">
                <label className="toggle-label">
                  <input
                    type="checkbox"
                    checked={activeSession?.rag_enabled || false}
                    onChange={(event) => handleSessionFieldChange(activeSessionId, { rag_enabled: event.target.checked })}
                    disabled={!activeSession || sending}
                  />
                  RAG Enabled
                </label>
                <label className="toggle-label">
                  <input
                    type="checkbox"
                    checked={activeSession?.streaming_enabled || false}
                    onChange={(event) => handleSessionFieldChange(activeSessionId, { streaming_enabled: event.target.checked })}
                    disabled={!activeSession || sending}
                  />
                  Streaming
                </label>
              </div>
            </div>
          </div>
          <div className="chat-header-right">
            <div className="layout-switches">
              <button className="ghost-btn" onClick={toggleSidebarVisibility}>
                {sidebarHidden ? 'Show Chats' : 'Hide Chats'}
              </button>
              <button className="ghost-btn" onClick={toggleActivityVisibility}>
                {activityVisible ? 'Hide Activity' : 'Show Activity'}
              </button>
            </div>
            <div className="header-user">
              <span>{user?.full_name || user?.email}</span>
              <button className="icon-btn" onClick={onLogout} title="Logout">
                ⎋
              </button>
            </div>
          </div>
        </header>

        {isMcpModalOpen && (
          <div className="modal-backdrop" onClick={handleCloseMcpModal}>
            <div
              className="modal-shell"
              role="dialog"
              aria-modal="true"
              aria-labelledby="mcp-modal-title"
              aria-describedby="mcp-modal-description"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="modal-header">
                <div>
                  <h2 id="mcp-modal-title">Configure MCP Servers</h2>
                  <p id="mcp-modal-description" className="muted">
                    Toggle server access and run tools for the active chat session.
                  </p>
                </div>
                <button className="icon-btn" onClick={handleCloseMcpModal} aria-label="Close MCP configuration">
                  ✕
                </button>
              </div>
              <div className="modal-content">
                <div className="panel">
                  <div className="panel-header">
                    <h3>Servers</h3>
                    <span className="muted">Enable servers available to this chat.</span>
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
                </div>
                <div className="panel">
                  <div className="panel-header">
                    <h3>Run Tool</h3>
                    <span className="muted">Execute an MCP tool using the active chat context.</span>
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
                      <button className="ghost-btn" onClick={handleCloseMcpModal}>
                        Close
                      </button>
                    </div>
                    {toolResult && (
                      <pre className="tool-output">{JSON.stringify(toolResult, null, 2)}</pre>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        <section ref={messagesContainerRef} className="messages" aria-live="polite">
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
              onChange={(event) => {
                if (!sending) {
                  setComposerText(event.target.value);
                }
              }}
              onKeyDown={handleComposerKeyDown}
              placeholder="Send a message..."
              rows={3}
              readOnly={sending}
              aria-disabled={sending}
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
              <button
                className="primary-btn"
                onClick={sending ? handleCancelSend : handleSendMessage}
                disabled={!sending && !activeSessionId}
              >
                {sending ? 'Cancel' : editingMessageId ? 'Resend' : 'Send'}
              </button>
            </div>
          </div>
        </footer>
      </main>

      <aside className="activity-drawer" aria-hidden={!activityVisible}>
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
        {activityVisible && (
          <div
            className="panel-resizer activity-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize activity panel"
            onPointerDown={handleActivityResizeStart}
          />
        )}
      </aside>
    </div>
  );
}
