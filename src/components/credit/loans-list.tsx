"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatPesos } from "@/server/money";
import { formatDateTime, loanStatusLabel, loanStatusTone } from "@/lib/credit-labels";
import type { LoanStatus } from "@/server/types";

interface LoanSummaryRow {
  id: string;
  loanNumber: string;
  productCode: string;
  status: LoanStatus;
  principalPesos: number;
  totalPayablePesos: number;
  outstandingPesos: number;
  createdAt: string;
}

export function LoansList({ userId }: { userId: string }) {
  const [loans, setLoans] = useState<LoanSummaryRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchLoans = async () => {
      try {
        // El uid NO se manda ni se usa para autorizar: `GET /api/loans` lo toma de la
        // cookie de sesión. `userId` solo sirve de clave para refetch.
        const res = await fetch("/api/loans");
        if (!res.ok) throw new Error("No se pudieron cargar los préstamos");
        const data = await res.json();
        setLoans(data.loans ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Error desconocido");
      } finally {
        setIsLoading(false);
      }
    };

    fetchLoans();
  }, [userId]);

  if (isLoading) {
    return (
      <div className="flex justify-center py-8" role="status">
        <span className="sr-only">Cargando tus préstamos</span>
        <div aria-hidden="true" className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 rounded-md bg-danger-bg text-danger text-sm" role="alert">
        {error}
      </div>
    );
  }

  if (loans.length === 0) {
    return (
      <Card className="w-full">
        <CardContent className="py-12 text-center">
          <p className="text-ink-muted mb-4">
            Todavía no tienes préstamos. Cuando se desembolse uno aprobado aparecerá aquí.
          </p>
          <Link href="/mis-solicitudes">
            <Button variant="secondary">Ver mis solicitudes</Button>
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <ul className="space-y-4">
      {loans.map((loan) => (
        <li key={loan.id}>
          <Card className="w-full">
            <CardHeader className="flex flex-row items-start justify-between gap-3 pb-2">
              <CardTitle className="text-lg">
                {loan.loanNumber}{" "}
                <Badge tone={loanStatusTone(loan.status)}>{loanStatusLabel(loan.status)}</Badge>
              </CardTitle>
              <Link href={`/mis-prestamos/${loan.id}`} className="shrink-0">
                <Button variant="ghost" size="sm">
                  Ver detalle
                  <span className="sr-only"> del préstamo {loan.loanNumber}</span>
                </Button>
              </Link>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-ink-muted">Capital</dt>
                  <dd className="font-medium text-ink">{formatPesos(loan.principalPesos)}</dd>
                </div>
                <div>
                  <dt className="text-ink-muted">Total a pagar</dt>
                  <dd className="font-medium text-ink">{formatPesos(loan.totalPayablePesos)}</dd>
                </div>
                <div>
                  <dt className="text-ink-muted">Saldo pendiente</dt>
                  <dd className="font-medium text-ink">{formatPesos(loan.outstandingPesos)}</dd>
                </div>
                <div>
                  <dt className="text-ink-muted">Creado</dt>
                  <dd className="font-medium text-ink">
                    <time dateTime={loan.createdAt}>{formatDateTime(loan.createdAt)}</time>
                  </dd>
                </div>
              </dl>
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}
