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

function classNames(...values) {
  return values.filter(Boolean).join(' ');
}

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

function parseMessageForThoughts(content) {
  if (!content || typeof content !== 'string') {
    return { displayContent: content, thoughts: null };
  }
  const pattern = /<think>([\s\S]*?)<\/think>/gi;
  const thoughts = [];
  let match;
  while ((match = pattern.exec(content)) !== null) {
    const value = match[1].trim();
    if (value) {
      thoughts.push(value);
    }
  }
  const displayContent = content.replace(pattern, '').trim();
  return {
    displayContent,
    thoughts: thoughts.length ? thoughts : null
  };
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
  const [expandedThoughts, setExpandedThoughts] = useState({});
  const appShellRef = useRef(null);
  const sendAbortControllerRef = useRef(null);
  const messagesContainerRef = useRef(null);
  const previousMessageCountRef = useRef(0);

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) || null,
    [sessions, activeSessionId]
  );
  const personaOptions = useMemo(() => config?.personas?.personas || [], [config]);
  const buttonStyles = useMemo(
    () => ({
      primary:
        'inline-flex items-center justify-center rounded-2xl bg-brand-primary px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-primary/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary disabled:cursor-not-allowed disabled:opacity-50',
      subtle:
        'inline-flex items-center justify-center rounded-2xl border border-transparent bg-white/70 px-3 py-2 text-sm font-semibold text-slate-600 transition hover:border-brand-primary/30 hover:text-brand-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary disabled:cursor-not-allowed disabled:opacity-50',
      ghost:
        'inline-flex items-center justify-center rounded-2xl px-3 py-2 text-sm font-semibold text-slate-500 transition hover:bg-white/60 hover:text-brand-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary disabled:cursor-not-allowed disabled:opacity-50',
      icon:
        'inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-white/30 bg-white/10 text-lg text-white/80 transition hover:border-brand-primary/50 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
      iconMuted:
        'inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-slate-200 bg-white/70 text-lg text-slate-500 transition hover:border-brand-primary/40 hover:text-brand-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary disabled:cursor-not-allowed disabled:opacity-40',
      pill:
        'inline-flex items-center rounded-full bg-brand-primary/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.35em] text-brand-primary'
    }),
    []
  );
  const messageRoleClasses = useMemo(
    () => ({
      user: 'border-brand-primary/40 bg-brand-primary/5',
      assistant: 'border-slate-200 bg-white/80',
      tool: 'border-amber-200 bg-amber-50',
      system: 'border-indigo-200 bg-indigo-50'
    }),
    []
  );
  const getAvatarTone = useCallback((role) => {
    if (role === 'user') return 'bg-brand-primary/10 text-brand-primary';
    if (role === 'assistant') return 'bg-slate-900 text-white';
    if (role === 'tool') return 'bg-amber-500/15 text-amber-600';
    return 'bg-slate-200 text-slate-600';
  }, []);
  const appShellClasses = useMemo(
    () => 'relative flex min-h-screen gap-6 px-6 py-6 xl:px-10 xl:py-8',
    []
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
        const maxWidth = 1800;
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

  const toggleThoughtsForMessage = useCallback(
    (messageId) => {
      setExpandedThoughts((prev) => ({
        ...prev,
        [messageId]: !prev[messageId]
      }));
    },
    [setExpandedThoughts]
  );

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
    <div className="relative min-h-screen">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[32rem] bg-[radial-gradient(circle_at_top,_rgba(226,29,56,0.16),_transparent_65%)]"
      />
      <div ref={appShellRef} className={appShellClasses}>
        <div
          className="relative flex h-full overflow-visible transition-[width,opacity] duration-300"
          style={{ width: sidebarHidden ? '0px' : `${sidebarWidth}px` }}
        >
          <aside
            className={classNames(
              'flex h-full flex-1 flex-col overflow-hidden rounded-3xl border border-white/10 bg-slate-950/90 text-white shadow-card backdrop-blur transition-opacity duration-200',
              sidebarHidden && 'pointer-events-none opacity-0'
            )}
            aria-hidden={sidebarHidden}
          >
            <div className="flex items-center justify-between gap-3 border-b border-white/10 px-6 py-5">
              <button className={buttonStyles.primary} onClick={handleCreateSession}>
                + New Chat
              </button>
              <button
                className={buttonStyles.icon}
                onClick={toggleSidebarVisibility}
                aria-label={sidebarHidden ? 'Show chat list' : 'Hide chat list'}
              >
                <span aria-hidden="true">{sidebarHidden ? '⟩' : '⟨'}</span>
              </button>
            </div>
            <div className="flex flex-1 flex-col overflow-hidden">
              <div className="flex items-center justify-between px-6 py-4">
                <h2 className="text-xs font-semibold uppercase tracking-[0.35em] text-white/55">Chats</h2>
                {loadingSessions && <span className="text-xs text-white/50">Loading…</span>}
              </div>
              <div className="flex-1 space-y-2 overflow-y-auto px-6 pb-6">
                {!loadingSessions && sessions.length === 0 && (
                  <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-6 text-sm text-white/70 shadow-inner">
                    Create a new chat to get started.
                  </div>
                )}
                {sessions.map((session) => (
                  <div
                    key={session.id}
                    className={classNames(
                      'group flex cursor-pointer items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-left transition hover:border-brand-primary/40 hover:bg-brand-primary/20 hover:text-white focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-white/70',
                      session.id === activeSessionId && 'border-brand-primary/60 bg-brand-primary/25 shadow-lg shadow-brand-primary/20'
                    )}
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
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm font-semibold">{session.title}</span>
                      <span className="text-xs text-white/60">{formatDate(session.created_at)}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 text-base text-white/70 transition hover:border-white/30 hover:text-white"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleRenameSession(session.id);
                        }}
                        aria-label="Rename session"
                      >
                        ✎
                      </button>
                      <button
                        className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 text-base text-white/70 transition hover:border-brand-primary/60 hover:text-brand-primary"
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
            <div className="border-t border-white/10 bg-white/5 px-6 py-4">
              <div className="flex items-center justify-between rounded-2xl border border-white/15 bg-white/10 px-3 py-2 text-sm">
                <span className="truncate text-white/80">{user?.full_name || user?.email}</span>
                <button
                  className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 text-base text-white/70 transition hover:border-brand-primary/60 hover:text-brand-primary"
                  onClick={onLogout}
                  title="Logout"
                >
                  ⎋
                </button>
              </div>
            </div>
          </aside>
          {!sidebarHidden && (
            <div
              className="absolute top-1/2 right-[-22px] z-30 flex -translate-y-1/2"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize chat list"
              onPointerDown={handleSidebarResizeStart}
              style={{ cursor: 'col-resize' }}
            >
              <div className="flex h-24 w-6 items-center justify-center rounded-full border border-white/40 bg-white/70 text-slate-400 shadow-sm transition hover:border-brand-primary hover:bg-brand-primary/20 hover:text-brand-primary">
                <span aria-hidden="true" className="text-sm font-semibold tracking-wide">
                  ||
                </span>
              </div>
            </div>
          )}
        </div>
        <main
          className="glass-card relative grid h-[calc(100vh-3rem)] flex-1 grid-rows-[auto,1fr,auto] overflow-hidden border border-white/50 bg-white/80 shadow-card"
          aria-busy={sending}
        >
          <div className="border-b border-slate-200/70 bg-white/80 backdrop-blur">
            <header className="flex flex-col gap-6 px-8 py-6">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex flex-wrap items-center gap-3">
                  <button className={buttonStyles.ghost} onClick={toggleSidebarVisibility}>
                    {sidebarHidden ? 'Show Chats' : 'Hide Chats'}
                  </button>
                  <button className={buttonStyles.ghost} onClick={toggleActivityVisibility}>
                    {activityVisible ? 'Hide Activity' : 'Show Activity'}
                  </button>
                </div>
                <div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white/60 px-3 py-2 text-sm font-semibold text-slate-600">
                  <span>{user?.full_name || user?.email}</span>
                  <button className={buttonStyles.iconMuted} onClick={onLogout} title="Logout">
                    ⎋
                  </button>
                </div>
              </div>
              <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
                <div className="space-y-3">
                  <span className={buttonStyles.pill}>{activeSession ? 'Active Chat' : 'Welcome'}</span>
                  <h1 className="text-2xl font-semibold text-slate-900">
                    {activeSession?.title || 'Select or create a chat'}
                  </h1>
                  <p className="max-w-xl text-sm text-slate-500">
                    Craft prompts, switch personas, and orchestrate MCP tooling from one canvas.
                  </p>
                </div>
                <div className="flex flex-col gap-4">
                  <div className="flex flex-wrap items-end gap-4">
                    <label className="flex flex-col text-sm font-semibold text-slate-500">
                      <span className="text-xs font-semibold uppercase tracking-[0.3em] text-slate-400">Model</span>
                      <select
                        className="mt-2 w-52 rounded-2xl border border-slate-200 bg-white/80 px-3 py-2 text-sm font-semibold text-slate-700 shadow-inner focus:border-brand-primary focus:outline-none focus:ring-2 focus:ring-brand-primary/30 disabled:cursor-not-allowed disabled:opacity-60"
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
                    <label className="flex flex-col text-sm font-semibold text-slate-500">
                      <span className="text-xs font-semibold uppercase tracking-[0.3em] text-slate-400">Persona</span>
                      <select
                        className="mt-2 w-52 rounded-2xl border border-slate-200 bg-white/80 px-3 py-2 text-sm font-semibold text-slate-700 shadow-inner focus:border-brand-primary focus:outline-none focus:ring-2 focus:ring-brand-primary/30 disabled:cursor-not-allowed disabled:opacity-60"
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
                    <button className={buttonStyles.subtle} onClick={handleOpenMcpModal} disabled={!activeSession}>
                      MCP Servers
                    </button>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white/70 px-4 py-2.5 text-sm font-semibold text-slate-600 shadow-sm transition hover:border-brand-primary/30 hover:text-brand-primary">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-brand-primary"
                        checked={activeSession?.rag_enabled || false}
                        onChange={(event) => handleSessionFieldChange(activeSessionId, { rag_enabled: event.target.checked })}
                        disabled={!activeSession || sending}
                      />
                      RAG Enabled
                    </label>
                    <label className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white/70 px-4 py-2.5 text-sm font-semibold text-slate-600 shadow-sm transition hover:border-brand-primary/30 hover:text-brand-primary">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-brand-primary"
                        checked={activeSession?.streaming_enabled || false}
                        onChange={(event) => handleSessionFieldChange(activeSessionId, { streaming_enabled: event.target.checked })}
                        disabled={!activeSession || sending}
                      />
                      Streaming
                    </label>
                  </div>
                </div>
              </div>
            </header>
            {statusMessage && (
              <div className="px-8 pb-4">
                <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-700 shadow-inner">
                  {statusMessage}
                </div>
              </div>
            )}
          </div>

          <section ref={messagesContainerRef} className="space-y-4 overflow-y-auto px-8 pb-8" aria-live="polite">
            {visibleMessages.length === 0 && (
              <div className="flex h-full flex-col items-center justify-center gap-4 rounded-3xl border border-dashed border-slate-200 bg-white/60 py-24 text-center">
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-brand-primary/10 text-3xl">💬</div>
                <h3 className="text-xl font-semibold text-slate-800">Start the conversation</h3>
                <p className="max-w-sm text-sm text-slate-500">
                  Send a prompt to see model responses, trace tools, and RAG activity.
                </p>
              </div>
            )}
            {visibleMessages.map((message) => {
              const { displayContent, thoughts } = parseMessageForThoughts(message.content);
              const hasThoughts = message.role === 'assistant' && thoughts;
              const isThoughtsExpanded = !!expandedThoughts[message.id];
              return (
                <article
                  key={message.id}
                  className={classNames(
                    'flex gap-4 rounded-3xl border px-5 py-4 shadow-sm backdrop-blur-sm transition hover:border-brand-primary/40',
                    messageRoleClasses[message.role] || 'border-slate-200 bg-white/70'
                  )}
                >
                  <div
                    className={classNames(
                      'flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-base font-semibold',
                      getAvatarTone(message.role)
                    )}
                    aria-hidden="true"
                  >
                    {getAvatarGlyph(message.role, user)}
                  </div>
                  <div className="flex flex-1 flex-col gap-3">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <span className="font-semibold text-slate-700">{getRoleLabel(message.role)}</span>
                      <span aria-hidden="true">•</span>
                      <span>{formatDate(message.created_at)}</span>
                      {message.edited_from_message_id && (
                        <span className="rounded-full bg-slate-900/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.25em] text-slate-600">
                          Edited
                        </span>
                      )}
                    </div>
                    {hasThoughts && (
                      <div className="space-y-2">
                        <button
                          type="button"
                          onClick={() => toggleThoughtsForMessage(message.id)}
                          className="flex w-full items-center justify-between rounded-2xl border border-slate-200 bg-slate-100/60 px-4 py-2 text-left text-xs font-semibold uppercase tracking-[0.3em] text-slate-600 transition hover:border-brand-primary/40 hover:text-brand-primary"
                          aria-expanded={isThoughtsExpanded}
                          aria-controls={`message-thoughts-${message.id}`}
                        >
                          <span>Thoughts</span>
                          <span aria-hidden="true">{isThoughtsExpanded ? '▴' : '▾'}</span>
                        </button>
                        {isThoughtsExpanded && (
                          <div
                            id={`message-thoughts-${message.id}`}
                            className="rounded-2xl border border-slate-200 bg-white/80 px-4 py-3 text-sm leading-relaxed text-slate-600 shadow-inner"
                          >
                            <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-slate-600">
                              {thoughts.join('\n\n')}
                            </pre>
                          </div>
                        )}
                      </div>
                    )}
                    {displayContent && (
                      <div className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">
                        {displayContent}
                      </div>
                    )}
                    {!displayContent && !hasThoughts && (
                      <div className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">
                        {message.content}
                      </div>
                    )}
                  </div>
                </article>
              );
            })}
          </section>

          <footer className="border-t border-slate-200/70 bg-white/80 px-8 py-6 backdrop-blur">
            <div className="flex flex-col gap-4">
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
                className="min-h-[120px] resize-none rounded-3xl border border-slate-200 bg-white/70 px-5 py-4 text-sm leading-relaxed text-slate-700 shadow-inner focus:border-brand-primary focus:outline-none focus:ring-2 focus:ring-brand-primary/30 disabled:cursor-not-allowed disabled:opacity-60"
              />
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-3">
                  <label className="relative inline-flex cursor-pointer items-center overflow-hidden rounded-2xl border border-slate-200 bg-white/80 px-3 py-2 text-sm font-semibold text-slate-600 transition hover:border-brand-primary/30 hover:text-brand-primary">
                    <span className="mr-2 text-lg" aria-hidden="true">
                      ＋
                    </span>
                    Attach
                    <input
                      type="file"
                      multiple
                      onChange={handleFileChange}
                      className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                    />
                  </label>
                  {!editingMessageId ? (
                    <button className={buttonStyles.ghost} onClick={handleStartEditing} disabled={!messages.length}>
                      Edit Last Message
                    </button>
                  ) : (
                    <button className={buttonStyles.ghost} onClick={handleCancelEditing}>
                      Cancel Edit
                    </button>
                  )}
                </div>
                <button
                  className={buttonStyles.primary}
                  onClick={sending ? handleCancelSend : handleSendMessage}
                  disabled={!sending && !activeSessionId}
                >
                  {sending ? 'Cancel' : editingMessageId ? 'Resend' : 'Send'}
                </button>
              </div>
            </div>
          </footer>
          {activityVisible && (
            <div
              className="absolute top-1/2 right-[-28px] z-40 flex -translate-y-1/2"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize activity panel"
              onPointerDown={handleActivityResizeStart}
              style={{ cursor: 'col-resize' }}
            >
              <div className="flex h-28 w-8 items-center justify-center rounded-full border-2 border-brand-primary/30 bg-white text-brand-primary shadow-lg transition hover:border-brand-primary hover:bg-brand-primary/10">
                <span aria-hidden="true" className="text-base font-semibold tracking-wide">
                  ⇆
                </span>
              </div>
            </div>
          )}
        </main>
        <div
          className="relative flex h-full overflow-visible transition-[width,opacity] duration-300"
          style={{ width: activityVisible ? `${activityWidth}px` : '0px' }}
        >
          <aside
            className={classNames(
              'flex h-full flex-1 flex-col overflow-hidden rounded-3xl border border-white/60 bg-white/75 shadow-card backdrop-blur transition-opacity duration-200',
              !activityVisible && 'pointer-events-none opacity-0'
            )}
            aria-hidden={!activityVisible}
          >
            <div className="border-b border-slate-200/70 bg-white/80 px-6 py-5">
              <h2 className="text-lg font-semibold text-slate-900">Internal Activity</h2>
              <p className="text-sm text-slate-500">Inspect retrieval, tools, and prompts per run.</p>
            </div>
            <div className="flex flex-1 flex-col">
              <div className="max-h-60 space-y-3 overflow-y-auto px-6 py-4">
                {runs.map((run) => (
                  <button
                    key={run.id}
                    className={classNames(
                      'w-full rounded-2xl border border-slate-200 bg-white/70 px-4 py-3 text-left text-sm shadow-sm transition hover:border-brand-primary/40 hover:bg-white',
                      selectedRun?.id === run.id && 'border-brand-primary/60 bg-brand-primary/10 text-brand-primary'
                    )}
                    onClick={() => handleSelectRun(run)}
                  >
                    <div className="flex items-center justify-between text-xs uppercase tracking-[0.2em] text-slate-400">
                      <span>{run.status.toUpperCase()}</span>
                      <span>{formatDate(run.started_at)}</span>
                    </div>
                    <div className="mt-1 text-sm font-semibold text-slate-700">{run.model_id || 'model'}</div>
                  </button>
                ))}
              </div>
              <div className="flex-1 overflow-y-auto px-6 py-6">
                {selectedRunDetails ? (
                  <div className="space-y-4">
                    <h3 className="text-sm font-semibold uppercase tracking-[0.3em] text-slate-400">Run Timeline</h3>
                    <div className="space-y-3">
                      {selectedRunDetails.steps.map((step) => (
                        <div key={step.id} className="rounded-2xl border border-slate-200 bg-white/80 p-4 shadow-sm">
                          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                              {step.type}
                            </span>
                            <span>{formatDate(step.ts)}</span>
                          </div>
                          {step.label && <div className="mt-2 text-sm font-semibold text-slate-700">{step.label}</div>}
                          {step.input_json && (
                            <pre className="mt-2 max-h-60 overflow-auto rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                              {JSON.stringify(step.input_json, null, 2)}
                            </pre>
                          )}
                          {step.output_json && (
                            <pre className="mt-2 max-h-60 overflow-auto rounded-xl border border-slate-200 bg-slate-900/90 px-3 py-2 text-xs text-white/80">
                              {JSON.stringify(step.output_json, null, 2)}
                            </pre>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-white/60 px-4 py-8 text-sm text-slate-500">
                    Select a run to inspect details.
                  </div>
                )}
              </div>
            </div>
          </aside>
        </div>
      </div>
      {isMcpModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 px-6 py-12 backdrop-blur-sm"
          onClick={handleCloseMcpModal}
        >
          <div
            className="glass-card w-full max-w-5xl overflow-hidden border border-white/60 bg-white/90 text-slate-900 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mcp-modal-title"
            aria-describedby="mcp-modal-description"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 border-b border-slate-200/70 px-6 py-5">
              <div>
                <h2 id="mcp-modal-title" className="text-xl font-semibold text-slate-900">
                  Configure MCP Servers
                </h2>
                <p id="mcp-modal-description" className="mt-1 text-sm text-slate-500">
                  Toggle server access and run tools for the active chat session.
                </p>
              </div>
              <button className={buttonStyles.iconMuted} onClick={handleCloseMcpModal} aria-label="Close MCP configuration">
                ✕
              </button>
            </div>
            <div className="grid gap-6 px-6 py-6 lg:grid-cols-2">
              <div className="space-y-4">
                <div className="space-y-2">
                  <h3 className="text-sm font-semibold uppercase tracking-[0.3em] text-slate-400">Servers</h3>
                  <p className="text-sm text-slate-500">Enable servers available to this chat.</p>
                </div>
                <div className="space-y-3">
                  {availableServers.map((server) => (
                    <label
                      key={server.name}
                      className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-white/80 px-4 py-3 text-sm shadow-sm transition hover:border-brand-primary/40 hover:bg-white focus-within:border-brand-primary/50"
                    >
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4 accent-brand-primary"
                        checked={activeSession?.enabled_mcp_servers?.includes(server.name) || false}
                        onChange={(event) => {
                          const enabled = new Set(activeSession?.enabled_mcp_servers || []);
                          if (event.target.checked) {
                            enabled.add(server.name);
                          } else {
                            enabled.delete(server.name);
                          }
                          handleSessionFieldChange(activeSessionId, {
                            enabled_mcp_servers: Array.from(enabled)
                          });
                        }}
                      />
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-slate-700">{server.name}</span>
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                            {server.transport}
                          </span>
                        </div>
                        {server.requires_api_key && (
                          <p className="text-xs text-slate-500">
                            Requires secret: {server.auth_key_name || 'API Key'}
                          </p>
                        )}
                      </div>
                    </label>
                  ))}
                </div>
              </div>
              <div className="space-y-4 rounded-2xl border border-slate-200 bg-white/80 p-5 shadow-inner">
                <div className="space-y-2">
                  <h3 className="text-sm font-semibold uppercase tracking-[0.3em] text-slate-400">Run a tool</h3>
                  <p className="text-sm text-slate-500">Send arguments as JSON to trigger MCP tools.</p>
                </div>
                <div className="grid gap-3">
                  <label className="text-sm font-semibold text-slate-600">
                    Server
                    <select
                      value={toolServer}
                      onChange={(event) => setToolServer(event.target.value)}
                      className="mt-1 w-full rounded-2xl border border-slate-200 bg-white/90 px-3 py-2 text-sm font-medium text-slate-700 shadow-inner focus:border-brand-primary focus:outline-none focus:ring-2 focus:ring-brand-primary/30"
                    >
                      <option value="">Select a server</option>
                      {availableServers.map((server) => (
                        <option key={server.name} value={server.name}>
                          {server.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-sm font-semibold text-slate-600">
                    Tool
                    <input
                      type="text"
                      value={toolName}
                      onChange={(event) => setToolName(event.target.value)}
                      placeholder="Tool name"
                      className="mt-1 w-full rounded-2xl border border-slate-200 bg-white/90 px-3 py-2 text-sm font-medium text-slate-700 shadow-inner focus:border-brand-primary focus:outline-none focus:ring-2 focus:ring-brand-primary/30"
                    />
                  </label>
                  <label className="text-sm font-semibold text-slate-600">
                    Arguments (JSON)
                    <textarea
                      value={toolArgs}
                      onChange={(event) => setToolArgs(event.target.value)}
                      rows={8}
                      placeholder={`{
  "foo": "bar"
}`}
                      className="mt-1 w-full rounded-2xl border border-slate-200 bg-white/90 px-3 py-2 text-sm font-medium text-slate-700 shadow-inner focus:border-brand-primary focus:outline-none focus:ring-2 focus:ring-brand-primary/30"
                    />
                  </label>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <button className={buttonStyles.primary} onClick={handleExecuteTool}>
                    Run Tool
                  </button>
                  <button className={buttonStyles.ghost} onClick={handleCloseMcpModal}>
                    Close
                  </button>
                </div>
                {toolResult && (
                  <pre className="max-h-60 overflow-auto rounded-2xl border border-slate-200 bg-slate-900/90 px-4 py-3 text-xs text-white/80">
                    {JSON.stringify(toolResult, null, 2)}
                  </pre>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
