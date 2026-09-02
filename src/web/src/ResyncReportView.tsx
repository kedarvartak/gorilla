import type { ResyncReport } from './api.js';
import { Lightning, Check, X } from '@phosphor-icons/react';

interface ResyncReportViewProps {
  readonly report: ResyncReport;
  readonly isDismissible?: boolean;
  readonly onDismiss?: () => void;
}

export function ResyncReportView({
  report,
  isDismissible = true,
  onDismiss,
}: ResyncReportViewProps) {
  if (report.error !== null) {
    return (
      <div className="border-b border-line bg-well px-4 py-2.5 text-[12.5px]">
        <div className="flex items-start gap-3">
          <X size={16} className="mt-0.5 shrink-0 text-danger" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-danger">{report.error}</p>
          </div>
          {isDismissible && onDismiss && (
            <button
              type="button"
              className="shrink-0 text-faint transition-colors hover:text-ink"
              onClick={onDismiss}
            >
              ✕
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="border-b border-line bg-well px-4 py-2.5 text-[12.5px]">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0">
          <div className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-tint">
            <Lightning size={12} className="text-brand" aria-hidden />
          </div>
        </div>

        <div className="min-w-0 flex-1 space-y-2">
          {/* Main message */}
          <p className="leading-snug text-dim">{report.note}</p>

          {/* Model and cost info */}
          {report.model !== null && (
            <div className="flex flex-wrap gap-2 pt-1">
              <span className="inline-flex items-center rounded bg-surface px-2 py-1 text-xs">
                <span className="text-faint">Model:</span>
                <span className="ml-1 font-mono text-ink">{report.model}</span>
              </span>

              {report.tokensSpent !== null && (
                <span className="inline-flex items-center rounded bg-surface px-2 py-1 text-xs">
                  <span className="text-faint">Tokens:</span>
                  <span className="ml-1 font-mono text-ink">
                    {report.tokensSpent.toLocaleString()}
                  </span>
                </span>
              )}
            </div>
          )}

          {/* Findings */}
          {report.findings.length > 0 && (
            <ul className="mt-2 space-y-1.5 pt-1">
              {report.findings.map((finding) => (
                <li key={finding.cardId} className="rounded bg-surface p-2">
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 shrink-0">
                      {finding.movedTo === null ? (
                        <span className="text-faint">—</span>
                      ) : (
                        <Check size={14} className="text-ok" aria-hidden />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-ink">{finding.title}</div>
                      {finding.movedTo !== null && (
                        <div className="text-xs text-ok">Moved to {finding.movedTo}</div>
                      )}
                      <div className="mt-0.5 text-xs text-faint">{finding.evidence}</div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {isDismissible && onDismiss && (
          <button
            type="button"
            className="shrink-0 text-faint transition-colors hover:text-ink"
            onClick={onDismiss}
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}
