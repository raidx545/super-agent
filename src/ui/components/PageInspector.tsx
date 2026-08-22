import type { PageState } from "../../types";

interface PageInspectorProps {
  pageState: PageState | null;
  onRefresh: () => void;
}

export function PageInspector({ pageState, onRefresh }: PageInspectorProps) {
  if (!pageState) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-8">
        <div className="text-4xl mb-4">🔍</div>
        <h3 className="text-sm font-medium text-gray-300 mb-2">
          Page Inspector
        </h3>
        <p className="text-[11px] text-gray-500 leading-relaxed mb-4">
          See exactly what the agent perceives on the current page.
          Elements, forms, metadata, and potential issues.
        </p>
        <button
          onClick={onRefresh}
          className="text-xs px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
        >
          Scan Current Page
        </button>
      </div>
    );
  }

  const elementsByType = pageState.elements.reduce(
    (acc, el) => {
      const key = el.tag;
      if (!acc[key]) acc[key] = [];
      acc[key].push(el);
      return acc;
    },
    {} as Record<string, typeof pageState.elements>
  );

  return (
    <div className="p-4 space-y-4">
      {/* Page Overview */}
      <div className="bg-gray-900 rounded-lg p-3 border border-gray-800">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold text-gray-300 truncate max-w-[70%]">
            {pageState.title}
          </h3>
          <button
            onClick={onRefresh}
            className="text-[10px] text-blue-400 hover:text-blue-300"
          >
            🔄 Refresh
          </button>
        </div>
        <p className="text-[10px] text-gray-500 truncate mb-2 font-mono">
          {pageState.url}
        </p>
        <div className="grid grid-cols-3 gap-2">
          <MetricCard
            label="Elements"
            value={pageState.elements.length.toString()}
            icon="🔘"
          />
          <MetricCard
            label="Forms"
            value={pageState.forms.length.toString()}
            icon="📝"
          />
          <MetricCard
            label="Confidence"
            value={`${Math.round(pageState.confidence * 100)}%`}
            icon="🎯"
            color={pageState.confidence > 0.8 ? "text-green-400" : "text-yellow-400"}
          />
        </div>
      </div>

      {/* Flags */}
      <div className="bg-gray-900 rounded-lg p-3 border border-gray-800">
        <h4 className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">
          Flags
        </h4>
        <div className="flex flex-wrap gap-1.5">
          <Flag
            label="HTTPS"
            active={pageState.metadata.isSecure}
            icon="🔒"
          />
          <Flag
            label="CAPTCHA"
            active={pageState.metadata.hasCAPTCHA}
            icon="🛡️"
            negative
          />
          <Flag
            label="Honeypot"
            active={pageState.metadata.hasHoneypot}
            icon="🍯"
            negative
          />
          <Flag
            label="File Upload"
            active={pageState.metadata.hasFileUpload}
            icon="📁"
          />
          <Flag
            label="Payment"
            active={pageState.metadata.hasPaymentForm}
            icon="💳"
          />
        </div>
      </div>

      {/* Elements Breakdown */}
      <div className="bg-gray-900 rounded-lg p-3 border border-gray-800">
        <h4 className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">
          Elements by Type
        </h4>
        <div className="space-y-2">
          {Object.entries(elementsByType).map(([tag, elements]) => (
            <div key={tag} className="flex items-center justify-between">
              <span className="text-[11px] text-gray-400">
                &lt;{tag}&gt;
              </span>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-gray-500">
                  {elements.length}
                </span>
                <div className="w-16 bg-gray-800 rounded-full h-1.5">
                  <div
                    className="bg-blue-500 h-1.5 rounded-full"
                    style={{
                      width: `${(elements.length / Math.max(pageState.elements.length, 1)) * 100}%`,
                    }}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Form Details */}
      {pageState.forms.length > 0 && (
        <div className="bg-gray-900 rounded-lg p-3 border border-gray-800">
          <h4 className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">
            Forms
          </h4>
          {pageState.forms.map((form) => (
            <div key={form.id} className="mb-3 last:mb-0">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] text-gray-300 font-mono">
                  {form.id}
                </span>
                <span className="text-[10px] text-gray-500">
                  {form.fields.length} fields
                </span>
              </div>
              <div className="space-y-1 ml-2">
                {form.fields.map((field, fi) => (
                  <div
                    key={fi}
                    className="flex items-center justify-between text-[10px]"
                  >
                    <span className="text-gray-400 truncate max-w-[60%]">
                      {field.label || field.name || field.id || `field-${fi}`}
                    </span>
                    <div className="flex items-center gap-1">
                      <span className="text-gray-600">{field.type}</span>
                      {field.required && (
                        <span className="text-red-400">*</span>
                      )}
                      {field.filledByUser && (
                        <span className="text-green-400">✓</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Perception Time */}
      <div className="text-center text-[10px] text-gray-600">
        Perceived in {pageState.perceptionTime.toFixed(1)}ms
      </div>
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────

function MetricCard({
  label,
  value,
  icon,
  color = "text-gray-300",
}: {
  label: string;
  value: string;
  icon: string;
  color?: string;
}) {
  return (
    <div className="bg-gray-800/50 rounded-lg p-2 text-center">
      <span className="text-sm block">{icon}</span>
      <span className={`text-sm font-bold ${color}`}>{value}</span>
      <span className="text-[9px] text-gray-500 block">{label}</span>
    </div>
  );
}

function Flag({
  label,
  icon,
  active,
  negative = false,
}: {
  label: string;
  icon: string;
  active: boolean;
  negative?: boolean;
}) {
  const isActive = negative ? !active : active;
  return (
    <span
      className={`text-[10px] px-2 py-0.5 rounded-full border ${
        isActive
          ? "bg-green-900/20 text-green-400 border-green-800/50"
          : "bg-gray-800 text-gray-500 border-gray-700"
      }`}
    >
      {icon} {label}
    </span>
  );
}
