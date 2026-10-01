import { describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { approveLoanApplication, rejectLoanApplication } from "./approval-service";
import { ApplicationStatus, Role } from "@/server/types";
import { createFirestoreMock, InMemoryFirestore } from "@/test-utils/firestore-mock";

const CREATED_AT = new Date("2026-09-20T08:00:00.000Z");
const APP_ID = "APP-2026-0007";
const KEY = "idem-key-1";
const ADMIN = { uid: "admin-1", role: Role.ADMIN };
const CUSTOMER = { uid: "customer-1", role: Role.CUSTOMER };

function buildApplication(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    applicationNumber: APP_ID,
    userId: "customer-1",
    productId: "MICRO_BASICO",
    requestedAmountPesos: 50000,
    termInstallments: 4,
    termFrequency: "BIWEEKLY",
    status: ApplicationStatus.SUBMITTED,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function buildScore(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    userId: "customer-1",
    applicationId: APP_ID,
    score: 78,
    riskLevel: "LOW",
    factors: [],
    modelVersion: "rule-v1",
    calculatedAt: CREATED_AT,
    ...overrides,
  };
}

function setup(options: { application?: Record<string, unknown> | null; score?: Record<string, unknown> | null } = {}): {
  db: Firestore;
  store: InMemoryFirestore;
} {
  const { store, db } = createFirestoreMock();

  const application = options.application === undefined ? buildApplication() : options.application;
  if (application) {
    store.seed("loan_applications", APP_ID, application);
  }

  const score = options.score === undefined ? buildScore() : options.score;
  if (score) {
    store.seed("credit_scores", APP_ID, score);
  }

  return { db, store };
}

function onlyAuditLog(store: InMemoryFirestore): Record<string, unknown> {
  const logs = store.list("audit_logs");
  expect(logs).toHaveLength(1);
  return logs[0];
}

describe("approval-service", () => {
  describe("approveLoanApplication", () => {
    it("aprueba una solicitud SUBMITTED y guarda la decisión con el uid del admin", async () => {
      const { db, store } = setup();

      const result = await approveLoanApplication({ db }, { applicationId: APP_ID, actor: ADMIN, idempotencyKey: KEY });

      expect(result.application.status).toBe(ApplicationStatus.APPROVED);
      expect(result.application.reviewedBy).toBe(ADMIN.uid);
      expect(result.application.decisionNotes).toBe("Aprobada por administrador");
      expect(result.application.reviewedAt).toBeInstanceOf(Date);

      const persisted = store.read("loan_applications", APP_ID);
      expect(persisted?.status).toBe(ApplicationStatus.APPROVED);
      expect(persisted?.reviewedBy).toBe(ADMIN.uid);
    });

    it("devuelve el score usado para aprobar", async () => {
      const { db } = setup({ score: buildScore({ score: 64, riskLevel: "MEDIUM" }) });

      const result = await approveLoanApplication({ db }, { applicationId: APP_ID, actor: ADMIN, idempotencyKey: KEY });

      expect(result.score).toEqual({ score: 64, riskLevel: "MEDIUM", modelVersion: "rule-v1" });
    });

    it("permite aprobar desde UNDER_REVIEW", async () => {
      const { db } = setup({ application: buildApplication({ status: ApplicationStatus.UNDER_REVIEW }) });

      const result = await approveLoanApplication({ db }, { applicationId: APP_ID, actor: ADMIN, idempotencyKey: KEY });

      expect(result.application.status).toBe(ApplicationStatus.APPROVED);
    });

    it("rechaza aprobar sin score calculado", async () => {
      const { db, store } = setup({ score: null });

      await expect(approveLoanApplication({ db }, { applicationId: APP_ID, actor: ADMIN, idempotencyKey: KEY })).rejects.toThrow(
        "No se puede aprobar una solicitud sin score crediticio calculado",
      );
      expect(store.read("loan_applications", APP_ID)?.status).toBe(ApplicationStatus.SUBMITTED);
    });

    it("rechaza aprobar una solicitud DRAFT (transición inválida)", async () => {
      const { db, store } = setup({ application: buildApplication({ status: ApplicationStatus.DRAFT }) });

      await expect(approveLoanApplication({ db }, { applicationId: APP_ID, actor: ADMIN, idempotencyKey: KEY })).rejects.toThrow(
        "No se puede decidir una solicitud en estado DRAFT",
      );
      expect(store.read("loan_applications", APP_ID)?.status).toBe(ApplicationStatus.DRAFT);
    });

    it("rechaza aprobar una solicitud ya APPROVED (transición inválida)", async () => {
      const { db } = setup({ application: buildApplication({ status: ApplicationStatus.APPROVED }) });

      await expect(approveLoanApplication({ db }, { applicationId: APP_ID, actor: ADMIN, idempotencyKey: KEY })).rejects.toThrow(
        "No se puede decidir una solicitud en estado APPROVED",
      );
    });

    it("rechaza aprobar una solicitud ya REJECTED (transición inválida)", async () => {
      const { db } = setup({ application: buildApplication({ status: ApplicationStatus.REJECTED }) });

      await expect(approveLoanApplication({ db }, { applicationId: APP_ID, actor: ADMIN, idempotencyKey: KEY })).rejects.toThrow(
        "No se puede decidir una solicitud en estado REJECTED",
      );
    });

    it("lanza NOT_FOUND si la solicitud no existe", async () => {
      const { db } = setup({ application: null });

      await expect(approveLoanApplication({ db }, { applicationId: APP_ID, actor: ADMIN, idempotencyKey: KEY })).rejects.toThrow(
        "Solicitud no encontrada",
      );
    });

    it("rechaza a un actor que no es ADMIN (solicitud ajena)", async () => {
      const { db, store } = setup();

      await expect(approveLoanApplication({ db }, { applicationId: APP_ID, actor: CUSTOMER, idempotencyKey: KEY })).rejects.toThrow(
        "Solo un administrador puede decidir sobre solicitudes",
      );
      expect(store.read("loan_applications", APP_ID)?.status).toBe(ApplicationStatus.SUBMITTED);
    });

    it("escribe auditoría LOAN_APPROVED con el score y el estado origen", async () => {
      const { db, store } = setup();

      await approveLoanApplication({ db }, { applicationId: APP_ID, actor: ADMIN, idempotencyKey: KEY });

      const audit = onlyAuditLog(store);
      expect(audit?.action).toBe("LOAN_APPROVED");
      expect(audit?.actorId).toBe(ADMIN.uid);
      expect(audit?.actorRole).toBe(Role.ADMIN);
      expect(audit?.entityType).toBe("loan_application");
      expect(audit?.entityId).toBe(APP_ID);
      expect(audit?.metadata).toMatchObject({
        fromStatus: ApplicationStatus.SUBMITTED,
        toStatus: ApplicationStatus.APPROVED,
        score: 78,
      });
    });

    it("crea notificación in-app para el cliente", async () => {
      const { db, store } = setup();

      await approveLoanApplication({ db }, { applicationId: APP_ID, actor: ADMIN, idempotencyKey: KEY });

      const notification = store.read("notifications", `${APP_ID}_approved`);
      expect(notification?.userId).toBe("customer-1");
      expect(notification?.type).toBe("LOAN_APPLICATION_APPROVED");
      expect(notification?.channel).toBe("IN_APP");
      expect(notification?.status).toBe("PENDING");
    });

    it("usa notas personalizadas cuando se proporcionan", async () => {
      const { db } = setup();

      const result = await approveLoanApplication(
        { db },
        { applicationId: APP_ID, actor: ADMIN, idempotencyKey: KEY, decisionNotes: "  Dentro del perfil  " },
      );

      expect(result.application.decisionNotes).toBe("Dentro del perfil");
    });
  });

  describe("idempotencia", () => {
    it("reproduce la misma respuesta sin volver a decidir ni auditar", async () => {
      const { db, store } = setup();

      const first = await approveLoanApplication({ db }, { applicationId: APP_ID, actor: ADMIN, idempotencyKey: KEY });
      const second = await approveLoanApplication({ db }, { applicationId: APP_ID, actor: ADMIN, idempotencyKey: KEY });

      expect(first.replayed).toBe(false);
      expect(second.replayed).toBe(true);
      expect(second.application).toEqual(first.application);
      expect(second.score).toEqual(first.score);

      // La auditoría y la notificación se escribieron una sola vez.
      expect(store.list("audit_logs")).toHaveLength(1);
      expect(store.ids("notifications")).toEqual([`${APP_ID}_approved`]);
    });

    it("mantiene las fechas como Date en la respuesta reproducida", async () => {
      const { db } = setup();

      await approveLoanApplication({ db }, { applicationId: APP_ID, actor: ADMIN, idempotencyKey: KEY });
      const replay = await approveLoanApplication({ db }, { applicationId: APP_ID, actor: ADMIN, idempotencyKey: KEY });

      expect(replay.application.reviewedAt).toBeInstanceOf(Date);
      expect(replay.application.createdAt).toBeInstanceOf(Date);
      expect(replay.application.updatedAt).toBeInstanceOf(Date);
    });

    it("exige Idempotency-Key para aprobar", async () => {
      const { db, store } = setup();

      await expect(
        approveLoanApplication({ db }, { applicationId: APP_ID, actor: ADMIN, idempotencyKey: "" }),
      ).rejects.toThrow("Falta el encabezado Idempotency-Key");
      expect(store.read("loan_applications", APP_ID)?.status).toBe(ApplicationStatus.SUBMITTED);
    });

    it("exige Idempotency-Key para rechazar", async () => {
      const { db } = setup();

      await expect(
        rejectLoanApplication({ db }, { applicationId: APP_ID, actor: ADMIN, idempotencyKey: "   ", decisionNotes: "Motivo" }),
      ).rejects.toThrow("Falta el encabezado Idempotency-Key");
    });

    it("con otra clave la solicitud ya decidida sigue rechazada (no re-decibe)", async () => {
      const { db, store } = setup();

      await approveLoanApplication({ db }, { applicationId: APP_ID, actor: ADMIN, idempotencyKey: KEY });

      await expect(
        approveLoanApplication({ db }, { applicationId: APP_ID, actor: ADMIN, idempotencyKey: "otra-clave" }),
      ).rejects.toThrow(`No se puede decidir una solicitud en estado ${ApplicationStatus.APPROVED}`);
      expect(store.list("audit_logs")).toHaveLength(1);
    });

    it("acepta la misma clave en approve y reject como decisiones distintas", async () => {
      const { db } = setup();

      await approveLoanApplication({ db }, { applicationId: APP_ID, actor: ADMIN, idempotencyKey: KEY });

      await expect(
        rejectLoanApplication({ db }, { applicationId: APP_ID, actor: ADMIN, idempotencyKey: KEY, decisionNotes: "Motivo" }),
      ).rejects.toThrow(`No se puede decidir una solicitud en estado ${ApplicationStatus.APPROVED}`);
    });
  });

  describe("rejectLoanApplication", () => {
    it("rechaza una solicitud SUBMITTED guardando el motivo", async () => {
      const { db, store } = setup();

      const result = await rejectLoanApplication(
        { db },
        { applicationId: APP_ID, actor: ADMIN, idempotencyKey: KEY, decisionNotes: "  Historial crediticio insuficiente  " },
      );

      expect(result.application.status).toBe(ApplicationStatus.REJECTED);
      expect(result.application.decisionNotes).toBe("Historial crediticio insuficiente");
      expect(result.application.reviewedBy).toBe(ADMIN.uid);

      const persisted = store.read("loan_applications", APP_ID);
      expect(persisted?.status).toBe(ApplicationStatus.REJECTED);
      expect(persisted?.decisionNotes).toBe("Historial crediticio insuficiente");
    });

    it("permite rechazar sin score calculado", async () => {
      const { db } = setup({ score: null });

      const result = await rejectLoanApplication(
        { db },
        { applicationId: APP_ID, actor: ADMIN, idempotencyKey: KEY, decisionNotes: "Fuera de política" },
      );

      expect(result.application.status).toBe(ApplicationStatus.REJECTED);
    });

    it("permite rechazar desde UNDER_REVIEW", async () => {
      const { db } = setup({ application: buildApplication({ status: ApplicationStatus.UNDER_REVIEW }) });

      const result = await rejectLoanApplication(
        { db },
        { applicationId: APP_ID, actor: ADMIN, idempotencyKey: KEY, decisionNotes: "Documentación incompleta" },
      );

      expect(result.application.status).toBe(ApplicationStatus.REJECTED);
    });

    it("exige motivo de rechazo no vacío", async () => {
      const { db, store } = setup();

      await expect(
        rejectLoanApplication({ db }, { applicationId: APP_ID, actor: ADMIN, idempotencyKey: KEY, decisionNotes: "   " }),
      ).rejects.toThrow("El motivo de rechazo es obligatorio");
      expect(store.read("loan_applications", APP_ID)?.status).toBe(ApplicationStatus.SUBMITTED);
    });

    it("rechaza rechazar una solicitud DRAFT (transición inválida)", async () => {
      const { db, store } = setup({ application: buildApplication({ status: ApplicationStatus.DRAFT }) });

      await expect(
        rejectLoanApplication({ db }, { applicationId: APP_ID, actor: ADMIN, idempotencyKey: KEY, decisionNotes: "No aplica" }),
      ).rejects.toThrow("No se puede decidir una solicitud en estado DRAFT");
      expect(store.read("loan_applications", APP_ID)?.status).toBe(ApplicationStatus.DRAFT);
    });

    it("rechaza rechazar una solicitud ya REJECTED (transición inválida)", async () => {
      const { db } = setup({ application: buildApplication({ status: ApplicationStatus.REJECTED }) });

      await expect(
        rejectLoanApplication({ db }, { applicationId: APP_ID, actor: ADMIN, idempotencyKey: KEY, decisionNotes: "No aplica" }),
      ).rejects.toThrow("No se puede decidir una solicitud en estado REJECTED");
    });

    it("lanza NOT_FOUND si la solicitud no existe", async () => {
      const { db } = setup({ application: null });

      await expect(
        rejectLoanApplication({ db }, { applicationId: APP_ID, actor: ADMIN, idempotencyKey: KEY, decisionNotes: "Motivo" }),
      ).rejects.toThrow("Solicitud no encontrada");
    });

    it("rechaza a un actor que no es ADMIN (solicitud ajena)", async () => {
      const { db, store } = setup();

      await expect(
        rejectLoanApplication({ db }, { applicationId: APP_ID, actor: CUSTOMER, idempotencyKey: KEY, decisionNotes: "Motivo" }),
      ).rejects.toThrow("Solo un administrador puede decidir sobre solicitudes");
      expect(store.read("loan_applications", APP_ID)?.status).toBe(ApplicationStatus.SUBMITTED);
    });

    it("escribe auditoría LOAN_REJECTED con el motivo", async () => {
      const { db, store } = setup();

      await rejectLoanApplication(
        { db },
        { applicationId: APP_ID, actor: ADMIN, idempotencyKey: KEY, decisionNotes: "Historial crediticio insuficiente" },
      );

      const audit = onlyAuditLog(store);
      expect(audit?.action).toBe("LOAN_REJECTED");
      expect(audit?.actorId).toBe(ADMIN.uid);
      expect(audit?.metadata).toMatchObject({
        fromStatus: ApplicationStatus.SUBMITTED,
        toStatus: ApplicationStatus.REJECTED,
        decisionNotes: "Historial crediticio insuficiente",
      });
    });

    it("crea notificación in-app de rechazo con el motivo", async () => {
      const { db, store } = setup();

      await rejectLoanApplication(
        { db },
        { applicationId: APP_ID, actor: ADMIN, idempotencyKey: KEY, decisionNotes: "Historial crediticio insuficiente" },
      );

      const notification = store.read("notifications", `${APP_ID}_rejected`);
      expect(notification?.userId).toBe("customer-1");
      expect(notification?.type).toBe("LOAN_APPLICATION_REJECTED");
      expect(notification?.status).toBe("PENDING");
      expect(notification?.body).toContain("Historial crediticio insuficiente");
    });
  });
});
