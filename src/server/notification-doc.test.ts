import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildNotificationDoc,
  installmentReminderRefKey,
  notificationDocId,
  NotificationType,
} from "./notification-doc";
import { NotificationStatus } from "./types";

const HOY = new Date("2026-03-24T12:00:00.000Z");

describe("notificationDocId", () => {
  it("es determinista: la misma cuota y estado caen en el mismo doc", () => {
    expect(notificationDocId("uid-1", NotificationType.INSTALLMENT_OVERDUE, "loan-a_2")).toBe(
      "uid-1_INSTALLMENT_OVERDUE_loan-a_2",
    );
    expect(notificationDocId("uid-1", NotificationType.INSTALLMENT_OVERDUE, "loan-a_2")).toBe(
      notificationDocId("uid-1", NotificationType.INSTALLMENT_OVERDUE, "loan-a_2"),
    );
  });

  it("distingue estado y cuota: una vencida y una próxima no se pisan", () => {
    const vencida = notificationDocId("uid-1", NotificationType.INSTALLMENT_OVERDUE, "loan-a_2");
    const proxima = notificationDocId("uid-1", NotificationType.INSTALLMENT_DUE_SOON, "loan-a_2");
    const otraCuota = notificationDocId("uid-1", NotificationType.INSTALLMENT_OVERDUE, "loan-a_3");
    expect(new Set([vencida, proxima, otraCuota]).size).toBe(3);
  });

  it("sanea lo que no puede ir en un doc ID de Firestore", () => {
    expect(notificationDocId("uid/1", NotificationType.INSTALLMENT_OVERDUE, "loan a#2")).toBe(
      "uid_1_INSTALLMENT_OVERDUE_loan_a_2",
    );
  });

  it("rechaza partes vacías y refKeys imposibles", () => {
    expect(() => notificationDocId("", NotificationType.INSTALLMENT_OVERDUE, "loan-a_1")).toThrow(RangeError);
    expect(() => notificationDocId("uid-1", NotificationType.INSTALLMENT_OVERDUE, "///")).toThrow(RangeError);
    expect(() => notificationDocId("u".repeat(1500), NotificationType.INSTALLMENT_OVERDUE, "x")).toThrow(
      RangeError,
    );
  });
});

describe("installmentReminderRefKey", () => {
  it("apunta a la cuota, no al préstamo", () => {
    expect(installmentReminderRefKey("loan-a", 3)).toBe("loan-a_3");
  });

  it("exige un número de cuota válido", () => {
    expect(() => installmentReminderRefKey("loan-a", 0)).toThrow(RangeError);
    expect(() => installmentReminderRefKey("loan-a", 1.5)).toThrow(RangeError);
  });
});

describe("buildNotificationDoc", () => {
  it("nace SENT con sentAt: la bandeja se ordena sin depender de un cron", () => {
    const doc = buildNotificationDoc(
      {
        userId: "uid-1",
        type: NotificationType.INSTALLMENT_DUE_SOON,
        title: "Tu cuota vence pronto",
        body: "La cuota 2 de $26.828 vence el 02/04/2026.",
      },
      HOY,
    );

    expect(doc.status).toBe(NotificationStatus.SENT);
    expect(doc.sentAt).toBe(HOY);
    expect(doc.channel).toBe("IN_APP");
    expect(doc.payload).toEqual({});
    expect(doc.readAt).toBeUndefined();
  });

  it("rechaza un cuerpo vacío: un aviso sin texto no sirve de nada", () => {
    expect(() =>
      buildNotificationDoc(
        { userId: "uid-1", type: NotificationType.INSTALLMENT_OVERDUE, title: " ", body: "algo" },
        HOY,
      ),
    ).toThrow(z.ZodError);
  });
});
