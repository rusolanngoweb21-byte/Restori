import type { Report, Signal } from "./scanner.ts";
import type { ThreatResult } from "./contracts.ts";
export type ExtendedReport = Report & { threat: ThreatResult };
/** Keep the main verdict and the detailed evidence aligned with the authoritative threat decision. */
export function withThreat(
  report: Report,
  threat: ThreatResult,
): ExtendedReport {
  const signals = report.signals.filter(
    (s) => s.id !== "reputation" && !s.id.startsWith("threat:"),
  );
  const observations: Signal[] = threat.checks.map((check, index) => ({
    id: "threat:" + index,
    group: "Подлинность",
    label: check.source,
    status:
      check.status === "malicious"
        ? "danger"
        : check.status === "clear"
          ? "pass"
          : "unknown",
    detail: check.detail,
    source: check.source,
    weight: 0,
  }));
  signals.push(...observations);
  return {
    ...report,
    signals,
    checked: signals.filter((s) => s.status !== "unknown").length,
    threat,
    limitation: report.limitation.replace("репутационные базы и ", ""),
    ...(threat.status === "blocked"
      ? {
          level: "high" as const,
          verdict: "Переход заблокирован",
          summary: threat.reason,
        }
      : {}),
  };
}
