"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatPesos } from "@/server/money";

export interface RiskFactor {
  factorKey: string;
  label: string;
  weightBps: number;
  value: number | string | boolean;
  contributionBps: number;
  reason: string;
}

interface ScoreExplanationPanelProps {
  score: number;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  factors: RiskFactor[];
  modelVersion: string;
  showTitle?: boolean;
}

const riskLevelLabels: Record<string, string> = {
  LOW: "Bajo",
  MEDIUM: "Medio",
  HIGH: "Alto",
};

const riskLevelTones: Record<string, "success" | "warning" | "danger" | "info"> = {
  LOW: "success",
  MEDIUM: "warning",
  HIGH: "danger",
};

export function ScoreExplanationPanel({
  score,
  riskLevel,
  factors,
  modelVersion,
  showTitle = true,
}: ScoreExplanationPanelProps) {
  const positiveFactors = factors.filter((f) => f.contributionBps > 0);
  const negativeFactors = factors.filter((f) => f.contributionBps < 0);
  const neutralFactors = factors.filter((f) => f.contributionBps === 0);

  const sortedFactors = [...factors].sort((a, b) => Math.abs(b.contributionBps) - Math.abs(a.contributionBps));

  return (
    <Card className="w-full">
      {showTitle && (
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            ¿Por qué este score?
            <Badge tone="info" aria-label="Versión del modelo">
              v{modelVersion}
            </Badge>
          </CardTitle>
        </CardHeader>
      )}
      <CardContent className="space-y-6">
        <div className="flex items-center justify-between p-4 rounded-lg bg-surface-muted">
          <div>
            <p className="text-sm text-ink-muted">Score de riesgo</p>
            <p className="text-3xl font-bold text-ink">{score}/100</p>
          </div>
          <Badge tone={riskLevelTones[riskLevel] ?? "neutral"} className="text-lg px-3 py-1">
            {riskLevelLabels[riskLevel] ?? riskLevel}
          </Badge>
        </div>

        <div className="space-y-4">
          {positiveFactors.length > 0 && (
            <section>
              <h4 className="font-medium text-success flex items-center gap-1">
                <span className="text-success">↑</span> Factores positivos
              </h4>
              <ul className="space-y-2 ml-4">
                {positiveFactors.map((factor) => (
                  <li key={factor.factorKey} className="flex items-center gap-2 text-sm">
                    <Badge tone="success" className="shrink-0">
                      +{factor.contributionBps} pts
                    </Badge>
                    <span className="text-ink font-medium">{factor.label}</span>
                    <span className="text-ink-muted">— {factor.reason}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {negativeFactors.length > 0 && (
            <section>
              <h4 className="font-medium text-danger flex items-center gap-1">
                <span className="text-danger">↓</span> Factores negativos
              </h4>
              <ul className="space-y-2 ml-4">
                {negativeFactors.map((factor) => (
                  <li key={factor.factorKey} className="flex items-center gap-2 text-sm">
                    <Badge tone="danger" className="shrink-0">
                      {factor.contributionBps} pts
                    </Badge>
                    <span className="text-ink font-medium">{factor.label}</span>
                    <span className="text-ink-muted">— {factor.reason}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {neutralFactors.length > 0 && (
            <section>
              <h4 className="font-medium text-ink-muted flex items-center gap-1">
                <span className="text-ink-muted">=</span> Factores neutros
              </h4>
              <ul className="space-y-2 ml-4">
                {neutralFactors.map((factor) => (
                  <li key={factor.factorKey} className="flex items-center gap-2 text-sm">
                    <Badge tone="neutral" className="shrink-0">
                      0 pts
                    </Badge>
                    <span className="text-ink-muted">{factor.label}</span>
                    <span className="text-ink-muted">— {factor.reason}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <details className="mt-4">
            <summary className="cursor-pointer text-sm text-ink-muted hover:text-ink">
              Ver todos los factores ordenados por impacto
            </summary>
            <ul className="space-y-2 mt-2 ml-4">
              {sortedFactors.map((factor) => (
                <li key={factor.factorKey} className="flex items-center gap-2 text-sm">
                  <Badge
                    tone={
                      factor.contributionBps > 0
                        ? "success"
                        : factor.contributionBps < 0
                        ? "danger"
                        : "neutral"
                    }
                    className="shrink-0"
                  >
                    {factor.contributionBps > 0 ? "+" : ""}{factor.contributionBps} pts
                  </Badge>
                  <span className="text-ink font-medium">{factor.label}</span>
                  <span className="text-ink-muted">— {factor.reason}</span>
                </li>
              ))}
            </ul>
          </details>
        </div>
      </CardContent>
    </Card>
  );
}

export function ScoreBadge({ score, riskLevel }: { score: number; riskLevel: "LOW" | "MEDIUM" | "HIGH" }) {
  const tones: Record<string, "success" | "warning" | "danger" | "info"> = {
    LOW: "success",
    MEDIUM: "warning",
    HIGH: "danger",
  };

  const labels: Record<string, string> = {
    LOW: "Bajo",
    MEDIUM: "Medio",
    HIGH: "Alto",
  };

  return (
    <div className="flex items-center gap-2">
      <span className="text-sm font-mono font-bold text-ink">{score}/100</span>
      <Badge tone={tones[riskLevel] ?? "info"}>{labels[riskLevel] ?? riskLevel}</Badge>
    </div>
  );
}