import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  fetchConfig,
  fetchModels,
  fetchSessions,
  fetchSession,
  createSession,
  updateSession,
  deleteSession,
  fetchMessages,
  sendMessage,
  editMessage,
  listRuns,
  getRun,
  runTool,
  fetchRagUploads,
  uploadRagFiles,
  deleteRagUpload,
  queryRag
} from '../api/index.js';

const MAX_FILE_SIZE_MB = 5;
const DEFAULT_RAG_ENABLED = true;
const DEFAULT_STREAMING_ENABLED = false;

function classNames(...values) {
  return values.filter(Boolean).join(' ');
}

function formatDate(value) {
  return new Date(value).toLocaleString();
}

function formatFileSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

function truncateText(value, maxLength = 160) {
  if (!value) return '';
  const stringValue = String(value).trim();
  if (stringValue.length <= maxLength) {
    return stringValue;
  }
  return `${stringValue.slice(0, maxLength)}…`;
}

function coerceContentToText(value) {
  if (!value) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (!item) return '';
        if (typeof item === 'string') return item;
        if (typeof item?.text === 'string') return item.text;
        if (typeof item?.content === 'string') return item.content;
        try {
          return JSON.stringify(item);
        } catch (error) {
          return '';
        }
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof value === 'object') {
    if (typeof value.text === 'string') {
      return value.text;
    }
    if (typeof value.content === 'string') {
      return value.content;
    }
    if (Array.isArray(value.content)) {
      return coerceContentToText(value.content);
    }
    try {
      return JSON.stringify(value);
    } catch (error) {
      return '';
    }
  }
  return String(value);
}

function getModelInputPreview(payload, toolSteps = []) {
  if (!payload) {
    return 'No input recorded.';
  }
  const messages =
    payload?.messages ||
    payload?.prompt ||
    payload?.input?.messages ||
    (Array.isArray(payload?.input?.prompt) ? payload.input.prompt : null);
  if (Array.isArray(messages) && messages.length) {
    const userLike = [...messages].reverse().find((message) => {
      const role = message?.role || message?.type;
      return role === 'user' || role === 'human';
    });
    const source = userLike || messages[messages.length - 1];
    const snippet =
      coerceContentToText(source?.content ?? source?.text ?? source?.message ?? source) ||
      coerceContentToText(messages);
    if (snippet) {
      return truncateText(snippet);
    }
  }
  if (typeof payload?.prompt === 'string' && payload.prompt) {
    return truncateText(payload.prompt);
  }
  const fallback = coerceContentToText(payload);
  if (fallback) {
    return truncateText(fallback);
  }
  if (toolSteps.length) {
    return `${toolSteps.length} tool result${toolSteps.length === 1 ? '' : 's'} merged into prompt.`;
  }
  return 'Prompt ready for the model.';
}

function getModelResponsePreview(output) {
  if (!output) {
    return 'No response captured.';
  }
  if (output?.error) {
    return truncateText(output.error);
  }
  const toolCalls = output?.tool_calls || output?.tools;
  if (Array.isArray(toolCalls) && toolCalls.length) {
    return `${toolCalls.length} tool call${toolCalls.length === 1 ? '' : 's'} requested by the model.`;
  }
  const content = output?.content ?? output?.text ?? output?.message;
  const snippet = coerceContentToText(content);
  if (snippet) {
    return truncateText(snippet);
  }
  try {
    return truncateText(JSON.stringify(output));
  } catch (error) {
    return 'Response recorded.';
  }
}

function getMessageStats(payload) {
  const result = {
    system: 0,
    user: 0,
    assistant: 0,
    tool: 0,
    other: 0
  };
  if (!payload) {
    return result;
  }
  const messages =
    payload?.messages ||
    payload?.input?.messages ||
    (Array.isArray(payload?.prompt) ? payload.prompt : null) ||
    (Array.isArray(payload) ? payload : null);
  if (!Array.isArray(messages)) {
    return result;
  }
  messages.forEach((message) => {
    const role = (message?.role || message?.type || '').toLowerCase();
    switch (role) {
      case 'system':
        result.system += 1;
        break;
      case 'user':
      case 'human':
        result.user += 1;
        break;
      case 'assistant':
      case 'ai':
        result.assistant += 1;
        break;
      case 'tool':
      case 'function':
        result.tool += 1;
        break;
      default:
        result.other += 1;
        break;
    }
  });
  return result;
}

function formatDuration(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = (seconds % 60).toFixed(0).padStart(2, '0');
  return `${minutes}:${remaining} min`;
}

function formatTokens(value) {
  if (value == null) return '—';
  return value.toLocaleString();
}

function extractPhasePreview(phaseId, steps) {
  if (!steps?.length) {
    return 'No activity recorded.';
  }
  const [firstStep] = steps;
  switch (phaseId) {
    case 'prompt': {
      const promptMessages = firstStep?.input_json?.messages || firstStep?.input_json?.prompt;
      if (Array.isArray(promptMessages)) {
        const combined = promptMessages
          .map((message) => message?.content || message?.text || '')
          .filter(Boolean)
          .join('\n');
        if (combined) {
          return truncateText(combined);
        }
      }
      if (typeof promptMessages === 'string') {
        return truncateText(promptMessages);
      }
      if (firstStep?.label) {
        return firstStep.label;
      }
      break;
    }
    case 'retrieval': {
      const chunkCount = firstStep?.output_json?.chunks?.length;
      if (chunkCount != null) {
        return `${chunkCount} chunk${chunkCount === 1 ? '' : 's'} retrieved.`;
      }
      if (firstStep?.label) {
        return firstStep.label;
      }
      break;
    }
    case 'tools': {
      const toolName = firstStep?.label || firstStep?.input_json?.tool || firstStep?.input_json?.tool_name;
      const status = firstStep?.output_json?.status || firstStep?.status;
      if (toolName) {
        return status ? `${toolName} (${status})` : toolName;
      }
      break;
    }
    case 'model': {
      const content = firstStep?.output_json?.content || firstStep?.output_json?.text;
      if (Array.isArray(content)) {
        const joined = content.map((item) => item?.text || '').filter(Boolean).join('\n');
        if (joined) {
          return truncateText(joined);
        }
      }
      if (typeof content === 'string') {
        return truncateText(content);
      }
      if (firstStep?.label) {
        return firstStep.label;
      }
      break;
    }
    default:
      break;
  }
  if (firstStep?.label) {
    return firstStep.label;
  }
  if (firstStep?.input_json) {
    return truncateText(JSON.stringify(firstStep.input_json));
  }
  if (firstStep?.output_json) {
    return truncateText(JSON.stringify(firstStep.output_json));
  }
  return 'Activity recorded.';
}

function getRunStatusStyles(status) {
  if (!status) {
    return 'border-slate-300 bg-slate-100 text-slate-600';
  }
  const normalized = status.toLowerCase();
  if (['completed', 'success', 'succeeded'].includes(normalized)) {
    return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  }
  if (['failed', 'error'].includes(normalized)) {
    return 'border-rose-200 bg-rose-50 text-rose-700';
  }
  if (['running', 'in_progress', 'pending'].includes(normalized)) {
    return 'border-amber-200 bg-amber-50 text-amber-700';
  }
  return 'border-slate-300 bg-slate-100 text-slate-600';
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

const markdownComponents = {
  a: ({ node, href, children, className, ...props }) => (
    <a
      href={href}
      {...props}
      target={href && href.startsWith('#') ? undefined : '_blank'}
      rel={href && href.startsWith('#') ? undefined : 'noreferrer'}
      className={classNames(
        'font-semibold text-brand-primary underline underline-offset-2 transition hover:text-brand-primary/80',
        className
      )}
    >
      {children}
    </a>
  )
};

export default function Workspace({ user, onLogout }) {
  const [config, setConfig] = useState(null);
  const [models, setModels] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [composerText, setComposerText] = useState('');
  const [editingMessageId, setEditingMessageId] = useState(null);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [sending, setSending] = useState(false);
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const [isActivityModalOpen, setIsActivityModalOpen] = useState(false);
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
  const [isRagModalOpen, setIsRagModalOpen] = useState(false);
  const [ragUploads, setRagUploads] = useState([]);
  const [ragSelectedFiles, setRagSelectedFiles] = useState([]);
  const [ragUploading, setRagUploading] = useState(false);
  const [ragQueryText, setRagQueryText] = useState('');
  const [ragQueryResults, setRagQueryResults] = useState([]);
  const [ragQueryLoading, setRagQueryLoading] = useState(false);
  const [ragModalStatus, setRagModalStatus] = useState(null);
  const [ragDeletingId, setRagDeletingId] = useState(null);
  const [expandedThoughts, setExpandedThoughts] = useState({});
  const [expandedEntries, setExpandedEntries] = useState({});
  const [showTransportDetails, setShowTransportDetails] = useState(false);
  const [copiedPayloadKey, setCopiedPayloadKey] = useState(null);
  const sendAbortControllerRef = useRef(null);
  const messagesContainerRef = useRef(null);
  const previousMessageCountRef = useRef(0);
  const responseAudioRef = useRef(null);
  const lastAssistantMessageIdRef = useRef(null);
  const responseAudioQueuedRef = useRef(false);

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) || null,
    [sessions, activeSessionId]
  );
  const personaOptions = useMemo(() => config?.personas?.personas || [], [config]);
  const globalDefaultMcpServers = useMemo(() => {
    const servers = config?.mcp?.servers || [];
    return servers.filter((server) => server.enabled_by_default).map((server) => server.name);
  }, [config]);
  const personaDefaultsMap = useMemo(() => {
    const map = new Map();
    const personas = config?.personas?.personas || [];
    const fallbackModel = config?.models?.default_model || '';
    const fallbackMcp = globalDefaultMcpServers;
    personas.forEach((persona) => {
      const mcpServers =
        persona.enabled_mcp_servers != null ? [...persona.enabled_mcp_servers] : [...fallbackMcp];
      map.set(persona.id, {
        modelId: persona.default_model_id || fallbackModel,
        ragEnabled: persona.rag_enabled ?? DEFAULT_RAG_ENABLED,
        streamingEnabled: persona.streaming_enabled ?? DEFAULT_STREAMING_ENABLED,
        mcpServers
      });
    });
    return map;
  }, [config, globalDefaultMcpServers]);
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
  const ragSelectedFilesList = useMemo(() => Array.from(ragSelectedFiles || []), [ragSelectedFiles]);
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

  const loadRagUploads = useCallback(async () => {
    try {
      const uploads = await fetchRagUploads();
      setRagUploads(uploads);
    } catch (error) {
      console.error('Failed to load RAG uploads', error);
      setRagModalStatus('Failed to load existing uploads.');
    }
  }, []);

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

  useEffect(() => {
    const audio = new Audio('/sounds/llm-response.wav');
    audio.volume = 0.4;
    responseAudioRef.current = audio;
    return () => {
      audio.pause();
      responseAudioRef.current = null;
    };
  }, []);

  useEffect(() => {
    lastAssistantMessageIdRef.current = null;
    responseAudioQueuedRef.current = false;
  }, [activeSessionId]);

  useEffect(() => {
    if (!isActivityModalOpen) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setIsActivityModalOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isActivityModalOpen]);

  useEffect(() => {
    setIsActivityModalOpen(false);
  }, [activeSessionId]);

  useEffect(() => {
    if (!copiedPayloadKey) return undefined;
    const timeout = setTimeout(() => setCopiedPayloadKey(null), 2000);
    return () => clearTimeout(timeout);
  }, [copiedPayloadKey]);

  useEffect(() => {
    if (!isRagModalOpen) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setIsRagModalOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isRagModalOpen]);

  useEffect(() => {
    if (!isRagModalOpen) return;
    setRagSelectedFiles([]);
    setRagModalStatus(null);
    setRagQueryResults([]);
    setRagQueryLoading(false);
    loadRagUploads();
  }, [isRagModalOpen, loadRagUploads]);

  useEffect(() => {
    setExpandedEntries({});
    setShowTransportDetails(false);
  }, [selectedRunDetails?.id]);

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
    if (!messages.length) {
      lastAssistantMessageIdRef.current = null;
      return;
    }

    const latestAssistant = [...messages]
      .slice()
      .reverse()
      .find((message) => message.role === 'assistant');

    if (!latestAssistant) {
      return;
    }

    if (latestAssistant.id === lastAssistantMessageIdRef.current) {
      return;
    }

    lastAssistantMessageIdRef.current = latestAssistant.id;

    if (!responseAudioQueuedRef.current) {
      return;
    }

    responseAudioQueuedRef.current = false;
    const audio = responseAudioRef.current;
    if (!audio) {
      return;
    }

    try {
      audio.currentTime = 0;
      const playback = audio.play();
      if (playback && typeof playback.catch === 'function') {
        playback.catch(() => {});
      }
    } catch (error) {
      console.warn('Unable to play response sound', error);
    }
  }, [messages]);

  useEffect(() => {
    if (activeResizer !== 'left') return undefined;

    const handlePointerMove = (event) => {
      event.preventDefault();
      const minWidth = 220;
      const maxWidth = 520;
      const nextWidth = Math.min(Math.max(event.clientX, minWidth), maxWidth);
      setSidebarWidth(nextWidth);
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

  const toggleSidebarVisibility = useCallback(() => {
    setSidebarHidden((prev) => !prev);
  }, []);

  const handleOpenActivityModal = useCallback(() => {
    if (!activeSession) return;
    setIsActivityModalOpen(true);
  }, [activeSession]);

  const handleCloseActivityModal = useCallback(() => {
    setIsActivityModalOpen(false);
  }, []);

  const handleOpenMcpModal = useCallback(() => {
    if (!activeSession) return;
    setIsMcpModalOpen(true);
  }, [activeSession]);

  const handleCloseMcpModal = useCallback(() => {
    setIsMcpModalOpen(false);
  }, []);

  const handleOpenRagModal = useCallback(() => {
    setIsRagModalOpen(true);
  }, []);

  const handleCloseRagModal = useCallback(() => {
    setIsRagModalOpen(false);
    setRagSelectedFiles([]);
    setRagQueryText('');
    setRagQueryResults([]);
    setRagModalStatus(null);
    setRagQueryLoading(false);
  }, []);

  const handleRagFileChange = (event) => {
    setRagSelectedFiles(event.target.files);
  };

  const handleUploadRagData = async () => {
    const filesArray = Array.from(ragSelectedFiles || []);
    if (!filesArray.length) {
      setRagModalStatus('Select at least one file to upload.');
      return;
    }
    const tooLarge = filesArray.find((file) => file.size > MAX_FILE_SIZE_MB * 1024 * 1024);
    if (tooLarge) {
      setRagModalStatus(`File "${tooLarge.name}" exceeds ${MAX_FILE_SIZE_MB} MB limit.`);
      return;
    }
    setRagUploading(true);
    setRagModalStatus(null);
    try {
      await uploadRagFiles(ragSelectedFiles);
      setRagModalStatus('Files uploaded successfully.');
      setRagSelectedFiles([]);
      await loadRagUploads();
    } catch (error) {
      console.error('Failed to upload RAG files', error);
      setRagModalStatus('Failed to upload files. Check console for details.');
    } finally {
      setRagUploading(false);
    }
  };

  const handleDeleteRagUpload = useCallback(
    async (uploadId) => {
      if (!uploadId) return;
      const target = ragUploads.find((upload) => upload.id === uploadId);
      const label = target?.filename || 'this upload';
      const confirmed = window.confirm(`Delete "${label}" from RAG?`);
      if (!confirmed) return;
      setRagModalStatus(null);
      setRagDeletingId(uploadId);
      try {
        await deleteRagUpload(uploadId);
        setRagUploads((uploads) => uploads.filter((upload) => upload.id !== uploadId));
        const targetFilename = target?.filename;
        setRagQueryResults((results) =>
          results.filter((chunk) => {
            if (targetFilename) {
              return chunk.filename !== targetFilename;
            }
            return chunk.id !== uploadId;
          })
        );
        setRagModalStatus('Upload deleted.');
      } catch (error) {
        console.error('Failed to delete RAG upload', error);
        setRagModalStatus('Failed to delete upload. Check console for details.');
      } finally {
        setRagDeletingId(null);
      }
    },
    [ragUploads, deleteRagUpload]
  );

  const handleRagQuery = async () => {
    if (!ragQueryText.trim()) {
      setRagModalStatus('Enter a query before running retrieval.');
      return;
    }
    setRagQueryLoading(true);
    setRagModalStatus(null);
    try {
      const { chunks } = await queryRag({ query: ragQueryText.trim() });
      setRagQueryResults(chunks);
      if (!chunks.length) {
        setRagModalStatus('No chunks retrieved for that query.');
      }
    } catch (error) {
      console.error('Failed to query RAG', error);
      setRagModalStatus('Failed to query RAG. Check console for details.');
    } finally {
      setRagQueryLoading(false);
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
    if (!activeSessionId || !composerText.trim() || sending) return;
    setSending(true);
    try {
      setStatusMessage(null);
      const controller = new AbortController();
      sendAbortControllerRef.current = controller;
      if (editingMessageId) {
        responseAudioQueuedRef.current = true;
        await editMessage(activeSessionId, editingMessageId, composerText.trim(), { signal: controller.signal });
      } else {
        responseAudioQueuedRef.current = true;
        await sendMessage(activeSessionId, composerText.trim(), { signal: controller.signal });
      }
      setComposerText('');
      setEditingMessageId(null);
      setStatusMessage(null);
      await loadMessages(activeSessionId);
      await loadRuns(activeSessionId);
      const sessionDetail = await fetchSession(activeSessionId);
      setSessions((prev) =>
        prev.map((session) => (session.id === activeSessionId ? sessionDetail : session))
      );
    } catch (error) {
      if (error?.name === 'CanceledError' || error?.code === 'ERR_CANCELED') {
        setStatusMessage('Message sending canceled.');
      } else {
        console.error(error);
        setStatusMessage('Failed to send message. Check console for details.');
      }
      responseAudioQueuedRef.current = false;
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
    responseAudioQueuedRef.current = false;
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

  const handleCopyPayload = useCallback(
    (payload, key) => {
      if (!payload) return;
      try {
        const payloadString = JSON.stringify(payload, null, 2);
        if (typeof navigator === 'undefined' || !navigator.clipboard) {
          console.warn('Clipboard API not available.');
          return;
        }
        navigator.clipboard
          .writeText(payloadString)
          .then(() => setCopiedPayloadKey(key))
          .catch((error) => console.error('Failed to copy payload', error));
      } catch (error) {
        console.error('Unable to serialise payload for copy', error);
      }
    },
    [setCopiedPayloadKey]
  );

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

  const timelineEntries = useMemo(() => {
    if (!selectedRunDetails?.steps?.length) {
      return [];
    }
    const sortedSteps = [...selectedRunDetails.steps].sort((a, b) => {
      const aTime = a?.ts ? new Date(a.ts).getTime() : 0;
      const bTime = b?.ts ? new Date(b.ts).getTime() : 0;
      return aTime - bTime;
    });
    const entries = [];
    const executedTools = [];

    const pushEntry = (entry) => {
      const summary = entry.summary && entry.summary.trim().length > 0 ? entry.summary : null;
      entries.push({
        ...entry,
        summary: summary || 'Details available below.'
      });
    };

    sortedSteps.forEach((step, index) => {
      const timestamp = step?.ts || null;
      const base = {
        timestamp,
        steps: [step]
      };

      if (step.type === 'system') {
        const systemText =
          coerceContentToText(
            step?.input_json?.content ??
              step?.input_json?.text ??
              step?.input_json?.prompt ??
              (Array.isArray(step?.input_json?.messages) ? step.input_json.messages : step.input_json)
          ) || step.label;
        pushEntry({
          ...base,
          id: `${step.id}-system`,
          icon: '🧭',
          title: 'System Prompt',
          summary: systemText ? truncateText(systemText) : 'System context applied.',
          payloadVisibility: step.input_json ? 'input' : step.output_json ? 'output' : null,
          defaultExpanded: index === 0
        });
        return;
      }

      if (step.type === 'prompt') {
        pushEntry({
          ...base,
          id: `${step.id}-prompt`,
          icon: '📝',
          title: 'User Prompt',
          summary: extractPhasePreview('prompt', [step]),
          payloadVisibility: step.input_json ? 'input' : step.output_json ? 'output' : null,
          defaultExpanded: entries.length === 0
        });
        return;
      }

      if (step.type === 'rag') {
        const chunkCount = Array.isArray(step?.output_json?.chunks) ? step.output_json.chunks.length : null;
        pushEntry({
          ...base,
          id: `${step.id}-retrieval`,
          icon: '📚',
          title: 'Retrieved Context',
          summary:
            chunkCount != null
              ? `${chunkCount} chunk${chunkCount === 1 ? '' : 's'} forwarded to the model.`
              : extractPhasePreview('retrieval', [step]),
          payloadVisibility: 'output',
          quickMeta:
            chunkCount != null
              ? [
                  {
                    label: 'Chunks',
                    value: String(chunkCount)
                  }
                ]
              : undefined
        });
        return;
      }

      if (step.type === 'tool' || step.type === 'mcp') {
        executedTools.push(step);
        const toolName =
          step?.label ||
          step?.input_json?.tool ||
          step?.input_json?.tool_name ||
          step?.output_json?.tool ||
          step?.output_json?.name;
        const serverName =
          step?.input_json?.server_name ||
          step?.input_json?.server ||
          step?.input_json?.server_id ||
          step?.output_json?.server;
        const status =
          step?.output_json?.status || step?.output_json?.state || (step?.output_json?.error ? 'error' : undefined);
        const outputSummary = (() => {
          if (step?.output_json?.error) {
            return truncateText(step.output_json.error);
          }
          const result = step?.output_json?.result ?? step?.output_json?.data ?? step?.output_json?.output;
          if (result != null) {
            if (typeof result === 'string') {
              return truncateText(result);
            }
            if (Array.isArray(result)) {
              return truncateText(
                result
                  .map((item) => {
                    if (typeof item === 'string') return item;
                    try {
                      return JSON.stringify(item);
                    } catch (error) {
                      return String(item);
                    }
                  })
                  .join('\n')
              );
            }
            if (typeof result === 'object') {
              try {
                return truncateText(JSON.stringify(result));
              } catch (error) {
                return 'Result ready.';
              }
            }
            return String(result);
          }
          const content = step?.output_json?.content;
          if (typeof content === 'string') {
            return truncateText(content);
          }
          if (Array.isArray(content)) {
            return truncateText(
              content
                .map((item) => {
                  if (typeof item === 'string') return item;
                  if (typeof item?.text === 'string') return item.text;
                  if (typeof item?.content === 'string') return item.content;
                  try {
                    return JSON.stringify(item);
                  } catch (error) {
                    return '';
                  }
                })
                .filter(Boolean)
                .join('\n')
            );
          }
          return status ? `Status: ${status}` : 'Execution finished.';
        })();
        const quickMeta = [
          ...(toolName ? [{ label: 'Tool', value: toolName }] : []),
          ...(serverName ? [{ label: 'Server', value: serverName }] : []),
          ...(status ? [{ label: 'Status', value: status }] : []),
          ...(step?.latency_ms != null ? [{ label: 'Latency', value: `${step.latency_ms} ms` }] : [])
        ];
        pushEntry({
          ...base,
          id: `${step.id}-tool`,
          icon: step.type === 'mcp' ? '🌐' : '🛠️',
          title: step.type === 'mcp' ? 'MCP Run' : 'Tool Run',
          summary: outputSummary,
          payloadVisibility: 'both',
          quickMeta: quickMeta.length ? quickMeta : undefined
        });
        return;
      }

      if (step.type === 'model') {
        if (step.input_json) {
          const messageStats = getMessageStats(step.input_json);
          const quickMeta = [];
          if (messageStats.system) {
            quickMeta.push({ label: 'System msgs', value: String(messageStats.system) });
          }
          if (messageStats.user) {
            quickMeta.push({ label: 'User msgs', value: String(messageStats.user) });
          }
          if (messageStats.tool) {
            quickMeta.push({ label: 'Tool msgs', value: String(messageStats.tool) });
          }
          pushEntry({
            ...base,
            id: `${step.id}-model-input`,
            icon: '📤',
            title: 'LLM API Request',
            summary: getModelInputPreview(step.input_json, executedTools),
            payloadVisibility: 'input',
            quickMeta:
              quickMeta.length || executedTools.length
                ? [
                    ...quickMeta,
                    ...(executedTools.length
                      ? [
                          {
                            label: 'Tool outputs',
                            value: String(executedTools.length)
                          }
                        ]
                      : [])
                  ]
                : undefined,
            defaultExpanded: entries.length === 0
          });
        }

        if (step.output_json) {
          const output = step.output_json;
          const toolCalls = Array.isArray(output?.tool_calls)
            ? output.tool_calls
            : Array.isArray(output?.tools)
            ? output.tools
            : null;
          const assistantText = coerceContentToText(output?.content ?? output?.text ?? output?.message);

          if (toolCalls?.length) {
            pushEntry({
              ...base,
              id: `${step.id}-tool-request`,
              icon: '🤖',
              title: toolCalls.length === 1 ? 'LLM Requested Tool' : 'LLM Requested Tools',
              summary: `Requested ${toolCalls.length === 1 ? 'a tool call' : `${toolCalls.length} tool calls`}.`,
              payloadVisibility: 'output',
              quickMeta: toolCalls.map((call, index) => ({
                label: toolCalls.length > 1 ? `Tool ${index + 1}` : 'Tool',
                value: call?.function?.name || call?.name || 'Tool call'
              })),
              defaultExpanded: true
            });
          }

          if (assistantText) {
            pushEntry({
              ...base,
              id: `${step.id}-assistant`,
              icon: toolCalls?.length ? '🗣️' : '💬',
              title: toolCalls?.length ? 'Assistant Follow-up' : 'LLM Response',
              summary: truncateText(assistantText),
              payloadVisibility: 'output',
              defaultExpanded: !toolCalls?.length
            });
          } else if (!toolCalls?.length && !entries.length) {
            pushEntry({
              ...base,
              id: `${step.id}-assistant-fallback`,
              icon: '💬',
              title: 'LLM Response',
              summary: getModelResponsePreview(output),
              payloadVisibility: 'output',
              defaultExpanded: true
            });
          }
        }
        return;
      }

      pushEntry({
        ...base,
        id: `${step.id}-other`,
        icon: '🔍',
        title: step.label || 'Additional Activity',
        summary: truncateText(
          step.label ||
            coerceContentToText(step.input_json) ||
            coerceContentToText(step.output_json) ||
            'Supplementary trace entry.'
        ),
        payloadVisibility: step.input_json && step.output_json ? 'both' : step.input_json ? 'input' : 'output'
      });
    });

    return entries;
  }, [selectedRunDetails]);

  const runDurationMs = useMemo(() => {
    if (!selectedRunDetails) return null;
    if (selectedRunDetails.latency_ms != null) return selectedRunDetails.latency_ms;
    if (!selectedRunDetails.finished_at || !selectedRunDetails.started_at) return null;
    return new Date(selectedRunDetails.finished_at).getTime() - new Date(selectedRunDetails.started_at).getTime();
  }, [selectedRunDetails]);
  const runRetryCount = useMemo(() => {
    if (!selectedRunDetails?.steps) return selectedRunDetails?.retry_count ?? null;
    const retries = selectedRunDetails.steps.filter((step) => step.type === 'retry').length;
    if (retries > 0) return retries;
    return selectedRunDetails?.retry_count ?? null;
  }, [selectedRunDetails]);
  const visibleMessages = useMemo(
    () => messages.filter((message) => !hiddenMessageIds.has(message.id)),
    [messages, hiddenMessageIds]
  );
  const selectedRunModelId = selectedRunDetails?.model_id || selectedRun?.model_id || 'model';
  const selectedRunStartedAt = selectedRunDetails?.started_at || selectedRun?.started_at || null;

  return (
    <div className="relative min-h-screen">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[32rem] bg-[radial-gradient(circle_at_top,_rgba(226,29,56,0.16),_transparent_65%)]"
      />
      <div className={appShellClasses}>
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
                  <button className={buttonStyles.ghost} onClick={handleOpenRagModal}>
                    RAG
                  </button>
                  <button
                    className={buttonStyles.ghost}
                    onClick={handleOpenActivityModal}
                    disabled={!activeSession}
                  >
                    Internal Activity
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
                        onChange={(event) => {
                          const nextPersonaId = event.target.value;
                          const defaults = personaDefaultsMap.get(nextPersonaId);
                          const patch = { persona_id: nextPersonaId };
                          if (defaults) {
                            patch.model_id = defaults.modelId;
                            patch.rag_enabled = defaults.ragEnabled;
                            patch.streaming_enabled = defaults.streamingEnabled;
                            patch.enabled_mcp_servers = [...defaults.mcpServers];
                          }
                          handleSessionFieldChange(activeSessionId, patch);
                        }}
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
                      message.role === 'assistant' ? (
                        <div className="markdown-content">
                          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                            {displayContent}
                          </ReactMarkdown>
                        </div>
                      ) : (
                        <div className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">
                          {displayContent}
                        </div>
                      )
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
              <div className="relative">
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
                  disabled={sending}
                  aria-disabled={sending}
                  className={classNames(
                    'min-h-[120px] w-full resize-none rounded-3xl border border-slate-200 bg-white/70 px-5 py-4 text-sm leading-relaxed text-slate-700 shadow-inner transition focus:border-brand-primary focus:outline-none focus:ring-2 focus:ring-brand-primary/30 disabled:cursor-not-allowed disabled:opacity-60',
                    sending && 'border-brand-primary/40 text-slate-500'
                  )}
                />
                {sending && (
                  <div className="composer-sending-overlay" role="status" aria-live="polite">
                    <div className="composer-sending-overlay__sheen" aria-hidden="true" />
                    <div className="composer-sending-overlay__content">
                      <div className="composer-sending-overlay__dots" aria-hidden="true">
                        <span className="composer-sending-overlay__dot" />
                        <span className="composer-sending-overlay__dot" />
                        <span className="composer-sending-overlay__dot" />
                      </div>
                      <span className="composer-sending-overlay__label">Sending to the model...</span>
                    </div>
                  </div>
                )}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-3">
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
        </main>
      </div>
      {isActivityModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 px-6 py-12 backdrop-blur-sm"
          onClick={handleCloseActivityModal}
        >
          <div
            className="glass-card flex h-full max-h-[calc(100vh-4rem)] min-h-[24rem] w-full max-w-[calc(100vw-3rem)] flex-col border border-white/60 bg-white/95 text-slate-900 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="activity-modal-title"
            aria-describedby="activity-modal-description"
            onClick={(event) => event.stopPropagation()}
            style={{ resize: 'both', overflow: 'auto' }}
          >
            <div className="flex items-start justify-between gap-4 border-b border-slate-200/70 px-6 py-5">
              <div>
                <h2 id="activity-modal-title" className="text-xl font-semibold text-slate-900">
                  Internal Activity
                </h2>
                <p id="activity-modal-description" className="mt-1 text-sm text-slate-500">
                  Inspect retrieval, tools, and prompts per run.
                </p>
              </div>
              <button
                className={buttonStyles.iconMuted}
                onClick={handleCloseActivityModal}
                aria-label="Close activity modal"
              >
                ✕
              </button>
            </div>
            <div className="flex-1 overflow-auto px-6 py-6">
              <div className="grid h-full gap-6 lg:grid-cols-[320px,1fr] lg:items-start">
                <div className="flex h-full flex-col space-y-4 overflow-hidden">
                  <div className="space-y-2">
                    <h3 className="text-sm font-semibold uppercase tracking-[0.3em] text-slate-400">Runs</h3>
                    <p className="text-sm text-slate-500">
                      {runs.length
                        ? 'Select a run to explore its trace timeline.'
                        : 'Send a prompt to see model responses, trace tools, and RAG activity.'}
                    </p>
                  </div>
                  {runs.length ? (
                    <div className="flex-1 space-y-3 overflow-y-auto pr-1">
                      {runs.map((run) => {
                        const isSelected = selectedRun?.id === run.id;
                        return (
                          <button
                            key={run.id}
                            className={classNames(
                              'w-full rounded-2xl border border-slate-200 bg-white/80 px-4 py-3 text-left text-sm shadow-sm transition hover:border-brand-primary/40 hover:bg-white',
                              isSelected && 'border-brand-primary/60 bg-brand-primary/10 text-brand-primary'
                            )}
                            onClick={() => handleSelectRun(run)}
                          >
                            <div className="flex items-center justify-between text-xs uppercase tracking-wide">
                              <span
                                className={classNames(
                                  'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold',
                                  getRunStatusStyles(run.status)
                                )}
                              >
                                {run.status || 'unknown'}
                              </span>
                              <span className="text-slate-400">{formatDate(run.started_at)}</span>
                            </div>
                            <div className="mt-2 flex items-center justify-between gap-3">
                              <div className="text-sm font-semibold text-slate-700">{run.model_id || 'model'}</div>
                              {run.latency_ms != null && (
                                <span className="text-xs font-medium text-slate-500">{formatDuration(run.latency_ms)}</span>
                              )}
                            </div>
                            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                              {run.total_tokens != null && <span>🧮 {formatTokens(run.total_tokens)} tokens</span>}
                              <span className="inline-flex items-center gap-1 text-slate-400">
                                <span aria-hidden="true">⛓️</span>
                                Flow
                              </span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="rounded-2xl border border-dashed border-slate-200 bg-white/70 px-4 py-6 text-sm text-slate-500">
                      Send a prompt to populate internal activity logs.
                    </div>
                  )}
                </div>
                <div className="flex min-h-[320px] flex-col rounded-2xl border border-slate-200 bg-white/80 p-5 shadow-inner">
                  {selectedRunDetails ? (
                    <div className="flex h-full flex-col space-y-6">
                      <div className="grid gap-4 md:grid-cols-3">
                        <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4 shadow-sm">
                          <div className="text-[11px] font-semibold uppercase tracking-[0.3em] text-slate-400">
                            Run summary
                          </div>
                          <div className="mt-3 space-y-2 text-sm text-slate-600">
                            <div className="flex items-center justify-between">
                              <span>Status</span>
                              <span
                                className={classNames(
                                  'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold uppercase tracking-wide',
                                  getRunStatusStyles(selectedRunDetails.status)
                                )}
                              >
                                {selectedRunDetails.status || 'unknown'}
                              </span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span>Model</span>
                              <span className="font-semibold text-slate-700">{selectedRunModelId}</span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span>Started</span>
                              <span>{selectedRunStartedAt ? formatDate(selectedRunStartedAt) : '—'}</span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span>Duration</span>
                              <span>{formatDuration(runDurationMs)}</span>
                            </div>
                          </div>
                        </div>
                        <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4 shadow-sm">
                          <div className="text-[11px] font-semibold uppercase tracking-[0.3em] text-slate-400">
                            Tokens
                          </div>
                          <div className="mt-3 space-y-2 text-sm text-slate-600">
                            <div className="flex items-center justify-between">
                              <span>Total</span>
                              <span className="font-semibold text-slate-700">{formatTokens(selectedRunDetails.total_tokens)}</span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span>Prompt</span>
                              <span>{formatTokens(selectedRunDetails.prompt_tokens)}</span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span>Completion</span>
                              <span>{formatTokens(selectedRunDetails.completion_tokens)}</span>
                            </div>
                          </div>
                        </div>
                        <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4 shadow-sm">
                          <div className="flex items-center justify-between">
                            <div className="text-[11px] font-semibold uppercase tracking-[0.3em] text-slate-400">
                              Details
                            </div>
                            <label className="flex items-center gap-2 text-xs font-semibold text-slate-500">
                              <input
                                type="checkbox"
                                className="h-4 w-4 accent-brand-primary"
                                checked={showTransportDetails}
                                onChange={(event) => setShowTransportDetails(event.target.checked)}
                              />
                              Transport metadata
                            </label>
                          </div>
                          <div className="mt-3 space-y-2 text-sm text-slate-600">
                            <div className="flex items-center justify-between">
                              <span>Finished</span>
                              <span>
                                {selectedRunDetails.finished_at
                                  ? formatDate(selectedRunDetails.finished_at)
                                  : '—'}
                              </span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span>Latency</span>
                              <span>{selectedRunDetails.latency_ms != null ? `${selectedRunDetails.latency_ms} ms` : '—'}</span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span>Retries</span>
                              <span>{runRetryCount != null ? runRetryCount : '—'}</span>
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <h3 className="text-sm font-semibold uppercase tracking-[0.3em] text-slate-400">Trace timeline</h3>
                        <p className="text-xs text-slate-500">Follow each handoff from prompt to response.</p>
                      </div>

                      <div className="flex-1 space-y-4 overflow-y-auto pr-1">
                        {timelineEntries.length ? (
                          <div className="relative pb-4">
                            <div className="absolute left-5 top-0 bottom-0 w-px bg-slate-200" aria-hidden="true" />
                            <div className="space-y-4">
                              {timelineEntries.map((entry, index) => {
                                const isExpanded =
                                  expandedEntries[entry.id] ??
                                  entry.defaultExpanded ??
                                  index === 0;
                                return (
                                  <div key={entry.id} className="relative pl-12">
                                    <div className="absolute left-0 top-5 flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white text-xl shadow-sm">
                                      <span aria-hidden="true">{entry.icon}</span>
                                    </div>
                                    <div className="rounded-2xl border border-slate-200 bg-white/80 shadow-sm">
                                      <button
                                        className="flex w-full items-start justify-between gap-4 px-4 py-4 text-left transition hover:bg-white"
                                        onClick={() =>
                                          setExpandedEntries((prev) => ({
                                            ...prev,
                                            [entry.id]: !isExpanded
                                          }))
                                        }
                                      >
                                        <div className="space-y-2">
                                          <div className="text-sm font-semibold text-slate-700">{entry.title}</div>
                                          <div className="text-xs text-slate-500">
                                            {entry.summary || 'No activity recorded.'}
                                          </div>
                                          {entry.quickMeta?.length ? (
                                            <div className="flex flex-wrap gap-2 pt-1">
                                              {entry.quickMeta.map((meta) => (
                                                <span
                                                  key={`${entry.id}-${meta.label}-${meta.value}`}
                                                  className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-slate-500"
                                                >
                                                  <span className="text-slate-400">{meta.label}</span>
                                                  <span className="text-slate-600">{meta.value}</span>
                                                </span>
                                              ))}
                                            </div>
                                          ) : null}
                                        </div>
                                        <div className="flex flex-col items-end gap-2 text-xs text-slate-500">
                                          {entry.timestamp && <span>{formatDate(entry.timestamp)}</span>}
                                          <span aria-hidden="true" className="text-base">
                                            {isExpanded ? '▴' : '▾'}
                                          </span>
                                        </div>
                                      </button>
                                      {isExpanded && (
                                        <div className="space-y-3 border-t border-slate-200 px-4 py-4">
                                          {entry.steps?.length ? (
                                            entry.steps.map((step) => {
                                              const metadataEntries = [];
                                              if (showTransportDetails) {
                                                const transportValue = step?.input_json?.transport || step?.output_json?.transport;
                                                const serverValue =
                                                  step?.input_json?.server_name ||
                                                  step?.input_json?.server ||
                                                  step?.input_json?.server_id ||
                                                  step?.output_json?.server_name;
                                                const urlValue =
                                                  step?.input_json?.base_url ||
                                                  step?.output_json?.base_url ||
                                                  step?.input_json?.endpoint ||
                                                  step?.output_json?.endpoint;
                                                if (transportValue) {
                                                  metadataEntries.push({ label: 'Transport', value: transportValue });
                                                }
                                                if (serverValue) {
                                                  metadataEntries.push({ label: 'Server', value: serverValue });
                                                }
                                                if (urlValue) {
                                                  metadataEntries.push({ label: 'URL', value: urlValue });
                                                }
                                              }
                                              const showInput = entry.payloadVisibility !== 'output';
                                              const showOutput = entry.payloadVisibility !== 'input';
                                              return (
                                                <div
                                                  key={`${entry.id}-${step.id}`}
                                                  className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600 shadow-inner"
                                                >
                                                  <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500">
                                                    <div className="inline-flex items-center gap-2">
                                                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                                                        {step.type}
                                                      </span>
                                                      {step.label && <span className="font-medium text-slate-600">{step.label}</span>}
                                                    </div>
                                                    <div className="flex flex-wrap items-center gap-3">
                                                      {step.latency_ms != null && <span>{step.latency_ms} ms</span>}
                                                      {step.ts && <span>{formatDate(step.ts)}</span>}
                                                    </div>
                                                  </div>
                                                  {metadataEntries.length > 0 && (
                                                    <div className="mt-3 flex flex-wrap gap-2 text-[11px] font-medium text-slate-500">
                                                      {metadataEntries.map((meta) => (
                                                        <span
                                                          key={`${step.id}-${meta.label}`}
                                                          className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-slate-600"
                                                        >
                                                          <span className="text-[9px] uppercase tracking-wide text-slate-400">{meta.label}</span>
                                                          <span className="font-semibold text-slate-600">{meta.value}</span>
                                                        </span>
                                                      ))}
                                                    </div>
                                                  )}
                                                  {showInput && step.input_json && (
                                                    <div className="mt-3 space-y-1">
                                                      <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                                                        <span>Input payload</span>
                                                        <button
                                                          className="rounded-full border border-slate-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500 transition hover:border-brand-primary/70 hover:text-brand-primary"
                                                          type="button"
                                                          onClick={() => handleCopyPayload(step.input_json, `${step.id}-input`)}
                                                        >
                                                          {copiedPayloadKey === `${step.id}-input` ? 'Copied' : 'Copy'}
                                                        </button>
                                                      </div>
                                                      <pre className="max-h-64 overflow-auto rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs leading-relaxed text-slate-700">
                                                        {JSON.stringify(step.input_json, null, 2)}
                                                      </pre>
                                                    </div>
                                                  )}
                                                  {showOutput && step.output_json && (
                                                    <div className="mt-3 space-y-1">
                                                      <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                                                        <span>Output payload</span>
                                                        <button
                                                          className="rounded-full border border-slate-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500 transition hover:border-brand-primary/70 hover:text-brand-primary"
                                                          type="button"
                                                          onClick={() => handleCopyPayload(step.output_json, `${step.id}-output`)}
                                                        >
                                                          {copiedPayloadKey === `${step.id}-output` ? 'Copied' : 'Copy'}
                                                        </button>
                                                      </div>
                                                      <pre className="max-h-64 overflow-auto rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs leading-relaxed text-slate-700">
                                                        {JSON.stringify(step.output_json, null, 2)}
                                                      </pre>
                                                    </div>
                                                  )}
                                                  {!showInput && !showOutput && !metadataEntries.length && !step.label && (
                                                    <div className="mt-3 text-xs text-slate-500">No additional payload recorded.</div>
                                                  )}
                                                </div>
                                              );
                                            })
                                          ) : (
                                            <div className="rounded-2xl border border-dashed border-slate-200 bg-white/70 px-4 py-6 text-sm text-slate-500">
                                              No recorded data for this entry.
                                            </div>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        ) : (
                          <div className="rounded-2xl border border-dashed border-slate-200 bg-white/70 px-4 py-6 text-sm text-slate-500">
                            No trace events captured for this run yet.
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-white/60 px-4 py-8 text-sm text-slate-500">
                      Select a run to inspect details.
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      {isRagModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 px-6 py-12 backdrop-blur-sm"
          onClick={handleCloseRagModal}
        >
          <div
            className="glass-card w-full max-w-5xl overflow-hidden border border-white/60 bg-white/90 text-slate-900 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rag-modal-title"
            aria-describedby="rag-modal-description"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 border-b border-slate-200/70 px-6 py-5">
              <div>
                <h2 id="rag-modal-title" className="text-xl font-semibold text-slate-900">
                  Manage RAG Data
                </h2>
                <p id="rag-modal-description" className="mt-1 text-sm text-slate-500">
                  Upload shared documents and test retrieval across all chats.
                </p>
              </div>
              <button className={buttonStyles.iconMuted} onClick={handleCloseRagModal} aria-label="Close RAG modal">
                ✕
              </button>
            </div>
            <div className="grid gap-6 px-6 py-6 lg:grid-cols-2">
              <div className="space-y-4">
                <div className="space-y-2">
                  <h3 className="text-sm font-semibold uppercase tracking-[0.3em] text-slate-400">Upload documents</h3>
                  <p className="text-sm text-slate-500">Files are available to every chat when RAG is enabled.</p>
                </div>
                <div className="space-y-4 rounded-2xl border border-slate-200 bg-white/80 p-5 shadow-inner">
                  <label className="relative inline-flex cursor-pointer items-center overflow-hidden rounded-2xl border border-slate-200 bg-white/90 px-4 py-2 text-sm font-semibold text-slate-600 transition hover:border-brand-primary/30 hover:text-brand-primary">
                    <span className="mr-2 text-lg" aria-hidden="true">＋</span>
                    Choose files
                    <input
                      type="file"
                      multiple
                      onChange={handleRagFileChange}
                      className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                    />
                  </label>
                  {ragSelectedFilesList.length > 0 && (
                    <ul className="space-y-2 rounded-2xl border border-slate-200 bg-white/90 p-3 text-sm text-slate-600">
                      {ragSelectedFilesList.map((file) => (
                        <li key={`${file.name}-${file.size}-${file.lastModified}`} className="flex items-center justify-between gap-3">
                          <span className="truncate font-semibold text-slate-700" title={file.name}>
                            {file.name}
                          </span>
                          <span className="text-xs text-slate-500">{formatFileSize(file.size)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <button
                    className={buttonStyles.primary}
                    onClick={handleUploadRagData}
                    disabled={ragUploading}
                  >
                    {ragUploading ? 'Uploading…' : 'Upload to RAG'}
                  </button>
                </div>
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold uppercase tracking-[0.3em] text-slate-400">Existing uploads</h4>
                  {ragUploads.length === 0 ? (
                    <p className="rounded-2xl border border-dashed border-slate-200 bg-white/70 px-4 py-3 text-sm text-slate-500">
                      No RAG documents uploaded yet.
                    </p>
                  ) : (
                    <ul className="space-y-2 max-h-48 overflow-y-auto">
                      {ragUploads.map((upload) => (
                        <li
                          key={upload.id}
                          className="rounded-2xl border border-slate-200 bg-white/80 px-4 py-3 text-sm shadow-sm"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <span className="block truncate font-semibold text-slate-700" title={upload.filename}>
                                {upload.filename}
                              </span>
                              <div className="mt-1 text-xs text-slate-400">Added {formatDate(upload.created_at)}</div>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-slate-500">{formatFileSize(upload.size_bytes)}</span>
                              <button
                                type="button"
                                onClick={() => handleDeleteRagUpload(upload.id)}
                                disabled={ragDeletingId === upload.id}
                                className="inline-flex items-center justify-center rounded-2xl border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-500 transition hover:border-red-200 hover:text-red-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-400 disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                {ragDeletingId === upload.id ? 'Deleting…' : 'Delete'}
                              </button>
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
              <div className="space-y-4">
                <div className="space-y-2">
                  <h3 className="text-sm font-semibold uppercase tracking-[0.3em] text-slate-400">Query RAG</h3>
                  <p className="text-sm text-slate-500">Send a prompt to preview retrieved chunks.</p>
                </div>
                <div className="space-y-4 rounded-2xl border border-slate-200 bg-white/80 p-5 shadow-inner">
                  <textarea
                    value={ragQueryText}
                    onChange={(event) => setRagQueryText(event.target.value)}
                    rows={4}
                    className="w-full resize-none rounded-2xl border border-slate-200 bg-white/90 px-4 py-3 text-sm leading-relaxed text-slate-700 shadow-inner focus:border-brand-primary focus:outline-none focus:ring-2 focus:ring-brand-primary/30"
                    placeholder="Ask something to test retrieval..."
                    disabled={ragQueryLoading}
                  />
                  <div className="flex justify-end">
                    <button
                      className={buttonStyles.primary}
                      onClick={handleRagQuery}
                      disabled={ragQueryLoading}
                    >
                      {ragQueryLoading ? 'Searching…' : 'Run Query'}
                    </button>
                  </div>
                  <div className="space-y-3 max-h-72 overflow-y-auto">
                    {ragQueryResults.length === 0 ? (
                      <div className="rounded-2xl border border-dashed border-slate-200 bg-white/60 px-4 py-6 text-sm text-slate-500">
                        {ragQueryLoading ? 'Searching for relevant chunks...' : 'Run a query to inspect retrieved chunks.'}
                      </div>
                    ) : (
                      ragQueryResults.map((chunk) => (
                        <div
                          key={chunk.id}
                          className="space-y-2 rounded-2xl border border-slate-200 bg-white/80 px-4 py-3 text-sm shadow-sm"
                        >
                          <div className="flex items-center justify-between gap-3 text-xs text-slate-500">
                            <span className="font-semibold text-slate-700">{chunk.filename || 'Chunk'}</span>
                            <span>Score {chunk.score != null ? chunk.score.toFixed(3) : '—'}</span>
                          </div>
                          <pre className="max-h-48 overflow-auto rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-600">
                            {chunk.text}
                          </pre>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>
            {ragModalStatus && (
              <div className="border-t border-slate-200/70 px-6 py-4">
                <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-700 shadow-inner">
                  {ragModalStatus}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

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
