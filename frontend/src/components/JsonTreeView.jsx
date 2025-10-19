import { useCallback, useMemo, useState } from 'react';

function isObjectLike(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function getPreviewLabel(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (isObjectLike(value)) {
    const keys = Object.keys(value);
    return `Object(${keys.length})`;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return '""';
    if (trimmed.length > 60) {
      return `"${trimmed.slice(0, 57)}…"`;
    }
    return `"${trimmed}"`;
  }
  return String(value);
}

function JsonNode({ label, value, path, depth, expandedPaths, onToggle }) {
  const isExpandable =
    (Array.isArray(value) && value.length > 0) ||
    (isObjectLike(value) && Object.keys(value).length > 0);
  const isExpanded = expandedPaths.has(path);

  const childBaseClass = 'ml-5 border-l border-slate-200/70 pl-4';

  if (!Array.isArray(value) && !isObjectLike(value)) {
    return (
      <div className="flex items-start gap-2 py-1" key={path}>
        <span className="select-none text-slate-300" aria-hidden="true">
          •
        </span>
        <div className="flex-1">
          {label != null && (
            <span className="mr-2 font-semibold text-slate-600">{label}:</span>
          )}
          <span className="whitespace-pre text-slate-500">{getPreviewLabel(value)}</span>
        </div>
      </div>
    );
  }

  const entries = useMemo(() => {
    if (Array.isArray(value)) {
      return value.map((item, index) => ({
        key: `[${index}]`,
        displayKey: `[${index}]`,
        childPath: `${path}[${index}]`,
        value: item
      }));
    }
    return Object.entries(value).map(([key, child]) => ({
      key,
      displayKey: key,
      childPath: `${path}.${key}`,
      value: child
    }));
  }, [value, path]);

  const handleToggle = useCallback(() => {
    onToggle(path);
  }, [path, onToggle]);

  return (
    <div className="py-1" key={path}>
      <div className="flex items-start gap-2">
        {isExpandable ? (
          <button
            type="button"
            onClick={handleToggle}
            className="mt-0.5 h-5 w-5 flex-shrink-0 rounded-full border border-slate-200/70 text-[11px] font-semibold text-slate-500 transition hover:border-brand-primary/60 hover:text-brand-primary"
            aria-expanded={isExpanded}
            aria-label={isExpanded ? 'Collapse section' : 'Expand section'}
          >
            {isExpanded ? '▾' : '▸'}
          </button>
        ) : (
          <span className="select-none text-slate-300" aria-hidden="true">
            •
          </span>
        )}
        <div className="flex-1">
          {label != null && (
            <span className="mr-2 font-semibold text-slate-600">{label}:</span>
          )}
          <span className="text-slate-500">{getPreviewLabel(value)}</span>
          {isExpanded && entries.length > 0 && (
            <div className={`${childBaseClass} mt-2 space-y-1`}>
              {entries.map((entry) => (
                <JsonNode
                  key={entry.childPath}
                  label={entry.displayKey}
                  value={entry.value}
                  path={entry.childPath}
                  depth={depth + 1}
                  expandedPaths={expandedPaths}
                  onToggle={onToggle}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function JsonTreeView({ data }) {
  const [expandedPaths, setExpandedPaths] = useState(() => new Set());

  const handleTogglePath = useCallback((targetPath) => {
    setExpandedPaths((previous) => {
      const next = new Set(previous);
      if (next.has(targetPath)) {
        next.delete(targetPath);
      } else {
        next.add(targetPath);
      }
      return next;
    });
  }, []);

  const renderRoot = useCallback(() => {
    if (Array.isArray(data)) {
      if (data.length === 0) {
        return <div className="text-sm text-slate-500">[]</div>;
      }
      return data.map((item, index) => (
        <JsonNode
          key={`$root[${index}]`}
          label={`[${index}]`}
          value={item}
          path={`$root[${index}]`}
          depth={0}
          expandedPaths={expandedPaths}
          onToggle={handleTogglePath}
        />
      ));
    }

    if (isObjectLike(data)) {
      const entries = Object.entries(data);
      if (entries.length === 0) {
        return <div className="text-sm text-slate-500">{'{}'}</div>;
      }
      return entries.map(([key, value]) => (
        <JsonNode
          key={`$root.${key}`}
          label={key}
          value={value}
          path={`$root.${key}`}
          depth={0}
          expandedPaths={expandedPaths}
          onToggle={handleTogglePath}
        />
      ));
    }

    return (
      <div className="py-1">
        <span className="text-sm text-slate-500">{getPreviewLabel(data)}</span>
      </div>
    );
  }, [data, expandedPaths, handleTogglePath]);

  return (
    <div className="space-y-1 font-mono text-[13px] leading-relaxed text-slate-700">
      {renderRoot()}
    </div>
  );
}
