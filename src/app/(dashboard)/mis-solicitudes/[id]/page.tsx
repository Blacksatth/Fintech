"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatPesos } from "@/server/money";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { useToast } from "@/components/ui/toast";
import { ScoreExplanationPanel, type RiskFactor } from "@/components/credit/score-explanation-panel";

interface LoanApplication {
  id: string;
  applicationNumber: string;
  userId: string;
  productId: string;
  requestedAmountPesos: number;
  termInstallments: number;
  termFrequency: string;
  status: string;
  decisionNotes?: string;
  reviewedAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface ScoreData {
  score: number;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  factors: RiskFactor[];
  modelVersion: string;
}

const statusLabels: Record<string, string> = {
  DRAFT: "Borrador",
  SUBMITTED: "Presentada",
  UNDER_REVIEW: "En revisión",
  APPROVED: "Aprobada",
  REJECTED: "Rechazada",
};

const statusTones: Record<string, "neutral" | "primary" | "success" | "warning" | "danger" | "info"> = {
  DRAFT: "neutral",
  SUBMITTED: "primary",
  UNDER_REVIEW: "info",
  APPROVED: "success",
  REJECTED: "danger",
};

const frequencyLabel = (freq: string) => {
  switch (freq) {
    case "WEEKLY":
      return "Semanal";
    case "BIWEEKLY":
      return "Quincenal";
    case "MONTHLY":
      return "Mensual";
    default:
      return freq;
  }
};

const formatDate = (dateStr: string) => {
  try {
    return format(new Date(dateStr), "dd/MM/yyyy HH:mm", { locale: es });
  } catch {
    return dateStr;
  }
};

export default function LoanApplicationDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { toast } = useToast();
  const id = params.id as string;
  const [application, setApplication] = useState<LoanApplication | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [score, setScore] = useState<ScoreData | null>(null);

  const fetchScore = async (appId: string) => {
    try {
      const res = await fetch(`/api/loan-applications/${appId}/score`);
      if (res.ok) {
        const data = await res.json();
        setScore(data.score);
      }
    } catch (err) {
      console.error("Error fetching score:", err);
    }
  };

  useEffect(() => {
    const fetchApplication = async () => {
      try {
        const res = await fetch(`/api/loan-applications/${id}`);
        if (!res.ok) throw new Error("Solicitud no encontrada");
        const data = await res.json();
        setApplication(data.application);
        await fetchScore(id);
      } catch (err) {
        console.error(err);
        toast("danger", "Error", "No se pudo cargar la solicitud");
        router.push("/mis-solicitudes");
      } finally {
        setIsLoading(false);
      }
    };

    fetchApplication();
  }, [id, router, toast]);

  const handleSubmit = async () => {
    if (!application) return;
    setIsSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`/api/loan-applications/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "submit" }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error?.message || "Error al presentar la solicitud");
      }

      toast("success", "Solicitud presentada", "Tu solicitud ha sido enviada para revisión.");
      router.push("/mis-solicitudes");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al presentar la solicitud");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
      </div>
    );
  }

  if (!application) {
    return null;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink">
            {application.applicationNumber}
          </h1>
          <p className="text-sm text-ink-muted">Detalle de la solicitud</p>
        </div>
        <Link href="/mis-solicitudes">
          <Button variant="ghost">Volver</Button>
        </Link>
      </div>

      {error && (
        <div className="p-4 rounded-md bg-danger-bg text-danger text-sm" role="alert">
          {error}
        </div>
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            {application.applicationNumber}
            <Badge tone={statusTones[application.status] ?? "neutral"}>
              {statusLabels[application.status] ?? application.status}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-ink-muted">Monto solicitado</dt>
              <dd className="font-medium text-ink text-lg">{formatPesos(application.requestedAmountPesos)}</dd>
            </div>
            <div>
              <dt className="text-ink-muted">Plazo</dt>
              <dd className="font-medium text-ink">
                {application.termInstallments} cuotas ({frequencyLabel(application.termFrequency)})
              </dd>
            </div>
            <div>
              <dt className="text-ink-muted">Fecha de creación</dt>
              <dd className="font-medium text-ink">{formatDate(application.createdAt)}</dd>
            </div>
            <div>
              <dt className="text-ink-muted">Última actualización</dt>
              <dd className="font-medium text-ink">{formatDate(application.updatedAt)}</dd>
            </div>
            {application.reviewedAt && (
              <div>
                <dt className="text-ink-muted">Fecha de revisión</dt>
                <dd className="font-medium text-ink">{formatDate(application.reviewedAt)}</dd>
              </div>
            )}
          </dl>

          {application.decisionNotes && (
            <div className="p-4 rounded-md bg-warning-bg border border-warning text-warning">
              <p className="font-medium">Nota de revisión:</p>
              <p className="mt-1">{application.decisionNotes}</p>
            </div>
          )}

          {score && (
            <ScoreExplanationPanel
              score={score.score}
              riskLevel={score.riskLevel}
              factors={score.factors}
              modelVersion={score.modelVersion}
              showTitle={false}
            />
          )}

          <div className="flex flex-col sm:flex-row gap-3 pt-4 border-t border-border">
            <Link href="/mis-solicitudes">
              <Button variant="ghost">Volver al listado</Button>
            </Link>
            {application.status === "DRAFT" && (
              <Button
                onClick={handleSubmit}
                disabled={isSubmitting}
                className="flex-1"
              >
                {isSubmitting ? "Presentando..." : "Presentar solicitud"}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}