import { getDb } from "@/lib/admin";
import { listUsersWithLimits } from "@/services/users/user-limit-service";
import { formatPesos } from "@/server/money";
import { Role, UserStatus } from "@/server/types";
import { UserLimitForm } from "@/components/admin/user-limit-form";
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui";
import { formatDateTime, shortUid } from "@/lib/credit-labels";

const ROLE_LABELS: Record<Role, string> = {
  [Role.ADMIN]: "Administrador",
  [Role.CUSTOMER]: "Cliente",
};

const STATUS_LABELS: Record<UserStatus, string> = {
  [UserStatus.ACTIVE]: "Activo",
  [UserStatus.SUSPENDED]: "Suspendido",
};

/**
 * Clientes (F13-2a).
 *
 * Lista los usuarios con su límite de crédito activo (`user_limit_overrides/{uid}`). El límite es
 * el tope que `findEligibleTier` aplica al tier: la pantalla solo muestra el límite que el admin
 * puso, y cada cambio queda auditado (`LIMIT_CHANGED`).
 */
export default async function AdminUsersPage() {
  const rows = await listUsersWithLimits(getDb());

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-ink">Usuarios</h1>
        <p className="text-sm text-ink-muted">
          {rows.length} usuario{rows.length === 1 ? "" : "s"} · ajusta cuánto puede pedir cada
          cliente; el cambio se audita
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Clientes y límites</CardTitle>
          <CardDescription>Un límite menor al del tier baja el monto elegible del cliente.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Usuario</TableHead>
                <TableHead>Rol</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>Límite actual</TableHead>
                <TableHead>
                  <span className="sr-only">Ajuste de límite</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableEmpty colSpan={5}>Todavía no hay usuarios.</TableEmpty>
              ) : (
                rows.map((row) => (
                  <TableRow key={row.uid}>
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="font-medium text-ink">{row.user.fullName}</span>
                        <span className="text-sm text-ink-muted">
                          {row.user.email} · {shortUid(row.uid)}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge tone={row.user.role === Role.ADMIN ? "primary" : "neutral"}>
                        {ROLE_LABELS[row.user.role]}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge tone={row.user.status === UserStatus.ACTIVE ? "success" : "danger"}>
                        {STATUS_LABELS[row.user.status]}
                      </Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {row.activeLimit && row.activeLimit.active ? (
                        <div className="flex flex-col">
                          <span className="font-semibold tabular-nums text-ink">
                            {formatPesos(row.activeLimit.creditLimitPesos)}
                          </span>
                          <span className="text-xs text-ink-subtle">
                            desde {formatDateTime(row.activeLimit.createdAt, "siempre")}
                          </span>
                        </div>
                      ) : (
                        <span className="text-sm text-ink-muted">Sin límite manual</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <UserLimitForm
                        uid={row.uid}
                        currentLimitPesos={row.activeLimit?.active ? row.activeLimit.creditLimitPesos : null}
                      />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}