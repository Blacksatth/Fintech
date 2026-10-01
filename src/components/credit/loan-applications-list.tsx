
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatPesos } from "@/server/money";
import { format } from "date-fns";
import { es } from "date-fns/locale";

interface FirestoreTimestamp {
  _seconds: number;
  _nanoseconds: number;
}

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

interface LoanApplicationsListProps {
  userId: string;
}

const statusLabels: Record<string, string> = {
  DRAFT: "Borrador",
  SUBMITTED: "Presentada",
  UNDER_REVIEW: "En revisión",
  APPROVED: "Aprobada",
  REJECTED: "Rechazada",
};

const statusTones: Record<
  string,
  "neutral" | "primary" | "success" | "warning" | "danger" | "info"
> = {
  DRAFT: "neutral",
  SUBMITTED: "primary",
  UNDER_REVIEW: "info",
  APPROVED: "success",
  REJECTED: "danger",
};

function normalizeFirestoreDate(value: unknown): string {
  if (!value) {
    return "";
  }

  // Ya viene como string ISO
  if (typeof value === "string") {
    return value;
  }

  // Firestore Timestamp serializado
  if (
    typeof value === "object" &&
    value !== null &&
    "_seconds" in value &&
    "_nanoseconds" in value
  ) {
    const timestamp = value as FirestoreTimestamp;

    return new Date(
      timestamp._seconds * 1000 + timestamp._nanoseconds / 1_000_000
    ).toISOString();
  }

  // Timestamp que llegue con toDate()
  if (
    typeof value === "object" &&
    value !== null &&
    "toDate" in value &&
    typeof value.toDate === "function"
  ) {
    return value.toDate().toISOString();
  }

  // Date
  if (value instanceof Date) {
    return value.toISOString();
  }

  return "";
}

/** Lo que llega por red: los campos propios son conocidos, las fechas todavia no. */
type RawLoanApplication = Omit<LoanApplication, "createdAt" | "updatedAt" | "reviewedAt"> & {
  createdAt: unknown;
  updatedAt: unknown;
  reviewedAt?: unknown;
};

function normalizeApplication(raw: RawLoanApplication): LoanApplication {
  return {
    ...raw,
    createdAt: normalizeFirestoreDate(raw.createdAt),
    updatedAt: normalizeFirestoreDate(raw.updatedAt),
    reviewedAt: raw.reviewedAt ? normalizeFirestoreDate(raw.reviewedAt) : undefined,
  };
}

export function LoanApplicationsList({
  userId,
}: LoanApplicationsListProps) {
  const [applications, setApplications] = useState<LoanApplication[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchApplications = async () => {
      try {
        const res = await fetch("/api/loan-applications");

        if (!res.ok) {
          throw new Error("No se pudieron cargar las solicitudes");
        }

        const data = await res.json();

        const normalizedApplications = ((data.applications ?? []) as RawLoanApplication[]).map(
          normalizeApplication,
        );

        setApplications(normalizedApplications);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Error desconocido"
        );
      } finally {
        setIsLoading(false);
      }
    };

    fetchApplications();
  }, [userId]);

  const formatDate = (dateStr: string) => {
    if (!dateStr) {
      return "—";
    }

    try {
      const date = new Date(dateStr);

      if (Number.isNaN(date.getTime())) {
        return "Fecha inválida";
      }

      return format(date, "dd/MM/yyyy HH:mm", {
        locale: es,
      });
    } catch {
      return "Fecha inválida";
    }
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

  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="p-4 rounded-md bg-danger-bg text-danger text-sm"
        role="alert"
      >
        {error}
      </div>
    );
  }

  if (applications.length === 0) {
    return (
      <Card className="w-full">
        <CardContent className="py-12 text-center">
          <p className="text-ink-muted mb-4">
            No tienes solicitudes aún.
          </p>

          <Link href="/solicitar">
            <Button>Crear mi primera solicitud</Button>
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {applications.map((app) => (
        <Card key={app.id} className="w-full">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <div>
              <CardTitle className="text-lg flex items-center gap-2">
                {app.applicationNumber}

                <Badge
                  tone={statusTones[app.status] ?? "neutral"}
                >
                  {statusLabels[app.status] ?? app.status}
                </Badge>
              </CardTitle>
            </div>

            {app.status === "DRAFT" && (
              <Link href={`/mis-solicitudes/${app.id}`}>
                <Button variant="ghost" size="sm">
                  Ver / Presentar
                </Button>
              </Link>
            )}
          </CardHeader>

          <CardContent className="space-y-3">
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-ink-muted">
                  Monto solicitado
                </dt>

                <dd className="font-medium text-ink">
                  {formatPesos(app.requestedAmountPesos)}
                </dd>
              </div>

              <div>
                <dt className="text-ink-muted">Plazo</dt>

                <dd className="font-medium text-ink">
                  {app.termInstallments} cuotas (
                  {frequencyLabel(app.termFrequency)})
                </dd>
              </div>

              <div>
                <dt className="text-ink-muted">
                  Fecha de creación
                </dt>

                <dd className="font-medium text-ink">
                  {formatDate(app.createdAt)}
                </dd>
              </div>

              <div>
                <dt className="text-ink-muted">
                  Última actualización
                </dt>

                <dd className="font-medium text-ink">
                  {formatDate(app.updatedAt)}
                </dd>
              </div>
            </dl>

            {app.decisionNotes && (
              <div className="p-3 rounded-md bg-warning-bg border border-warning text-warning text-sm">
                <p className="font-medium">
                  Nota de revisión:
                </p>

                <p>{app.decisionNotes}</p>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

