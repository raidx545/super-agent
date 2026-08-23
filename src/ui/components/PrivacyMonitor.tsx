import { useState, useEffect, useCallback } from "react";
import {
  getStats,
  onStatsChange,
  getPrivacyScore,
  generatePrivacyProof,
} from "../../core/privacy/network-monitor";
import type { NetworkStats } from "../../core/privacy/network-monitor";

export function PrivacyMonitor() {
  const [stats, setStats] = useState<NetworkStats>(getStats());
  const [showProof, setShowProof] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const unsub = onStatsChange((newStats) => {
      setStats({ ...newStats });
    });
    return unsub;
  }, []);

  const privacyScore = getPrivacyScore();
  const elapsed = stats.isMonitoring
    ? ((Date.now() - stats.startedAt) / 1000).toFixed(0)
    : "0";

  const copyProof = useCallback(() => {
    navigator.clipboard.writeText(generatePrivacyProof());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, []);

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-300">Privacy monitor</h2>
        <span
          className="text-[10px] px-2 py-0.5 rounded-full font-medium"
          style={{
            backgroundColor: `${privacyScore.color}20`,
            color: privacyScore.color,
            border: `1px solid ${privacyScore.color}40`,
          }}
        >
          {privacyScore.label}
        </span>
      </div>

      {/* Privacy Score Ring */}
      <div className="flex justify-center">
        <div className="relative w-32 h-32">
          <svg className="w-32 h-32 -rotate-90" viewBox="0 0 120 120">
            <circle
              cx="60"
              cy="60"
              r="52"
              fill="none"
              stroke="#1f2937"
              strokeWidth="8"
            />
            <circle
              cx="60"
              cy="60"
              r="52"
              fill="none"
              stroke={privacyScore.color}
              strokeWidth="8"
              strokeDasharray={`${(privacyScore.score / 100) * 327} 327`}
              strokeLinecap="round"
              className="transition-all duration-1000"
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span
              className="text-2xl font-bold"
              style={{ color: privacyScore.color }}
            >
              {privacyScore.score}
            </span>
            <span className="text-[10px] text-gray-500">Privacy Score</span>
          </div>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 gap-3">
        <StatCard
          label="Monitoring"
          value={stats.isMonitoring ? `${elapsed}s` : "Off"}
        />
        <StatCard label="Total Requests" value={String(stats.totalRequests)} />
        <StatCard
          label="Outbound"
          value={String(stats.outboundRequests)}
          alert={stats.outboundRequests > 0}
        />
        <StatCard
          label="Blocked"
          value={String(stats.blockedRequests.length)}
        />
      </div>

      {/* Zero Request Banner */}
      {stats.isMonitoring && stats.outboundRequests === 0 && (
        <div className="bg-green-900/20 border border-green-800/30 rounded-lg p-3 text-center">
          <p className="text-xs text-green-400 font-medium">
            Zero Outbound Requests
          </p>
          <p className="text-[10px] text-gray-500 mt-1">
            All processing happened in your browser. Nothing left your device.
          </p>
        </div>
      )}

      {/* Outbound Warning */}
      {stats.outboundRequests > 0 && (
        <div className="bg-red-900/20 border border-red-800/30 rounded-lg p-3">
          <p className="text-xs text-red-400 font-medium mb-1">
            {stats.outboundRequests} Outbound Request(s) Detected
          </p>
          {Array.from(stats.requestsByDomain.entries())
            .filter(
              ([d]) => d !== "localhost" && !d.includes("chrome-extension"),
            )
            .map(([domain, count]) => (
              <div
                key={domain}
                className="flex justify-between text-[10px] text-gray-400"
              >
                <span>{domain}</span>
                <span>{count}</span>
              </div>
            ))}
        </div>
      )}

      {/* Privacy Proof */}
      <div className="space-y-2">
        <button
          onClick={() => setShowProof(!showProof)}
          className="w-full text-[11px] text-gray-400 hover:text-gray-300 py-2 border border-gray-800 rounded-lg transition-colors"
        >
          {showProof ? "Hide" : "Show"} Privacy Proof
        </button>
        {showProof && (
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-3">
            <pre className="text-[10px] text-gray-400 whitespace-pre-wrap font-mono leading-relaxed">
              {generatePrivacyProof()}
            </pre>
            <button
              onClick={copyProof}
              className="mt-2 w-full text-[10px] text-blue-400 hover:text-blue-300 py-1"
            >
              {copied ? "Copied" : "Copy proof"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  alert,
}: {
  label: string;
  value: string;
  alert?: boolean;
}) {
  return (
    <div
      className={`bg-gray-900 rounded-lg p-3 border ${alert ? "border-red-800/50" : "border-gray-800"}`}
    >
      <span className="text-[10px] text-gray-500">{label}</span>
      <span
        className={`text-lg font-bold ${alert ? "text-red-400" : "text-gray-300"}`}
      >
        {value}
      </span>
    </div>
  );
}
