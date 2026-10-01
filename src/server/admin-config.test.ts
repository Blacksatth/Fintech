import { describe, expect, it } from "vitest";
import {
  CONFIG_ENTITY_TYPES,
  assertChannelStaysPublishable,
  assertProductHasActiveTier,
  assertProductKeepsActiveRate,
  assertTierAmountsAscend,
  diffConfigFields,
  interestRateDocId,
  mergeChannelMeta,
  nextRateVersion,
  parseThresholdsForWrite,
  productTierDocId,
  type PaymentChannelMetaPatch,
} from "./admin-config";
import {
  PAYMENT_CHANNEL_LEGAL_REVIEW_DEMO,
  PAYMENT_CHANNEL_LEGAL_REVIEW_REPLACED,
  isPublicPaymentChannelMetaKey,
} from "@/server/payment-doc";
import { AppError, ErrorCode } from "@/lib/errors";
import { TermFrequency } from "@/server/types";
import {
  buildCreditProductDoc,
  buildInterestRateDoc,
  buildProductTierDoc,
  Currency,
  type CreditProductDoc,
  type InterestRateDoc,
  type ProductTierDoc,
} from "@/server/credit-doc";

const NOW = new Date("2026-03-01T12:00:00.000Z");
const LATER = new Date("2026-06-01T12:00:00.000Z");

/**
 * `badRequest`/`conflict` son fábricas que devuelven un `AppError`, no clases: `expect(fn).toThrow(
 * badRequest)` comprobaría `instanceof` contra una función y nunca pasaría. Lo que importa para el
 * cliente es el código y el status que sale por HTTP, así que se mira eso.
 */
function expectAppError(fn: () => void, code: ErrorCode, status: number): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(AppError);
  const error = thrown as AppError;
  expect(error.code).toBe(code);
  expect(error.statusCode).toBe(status);
}

function product(overrides: Partial<CreditProductDoc> = {}): CreditProductDoc {
  return {
    ...buildCreditProductDoc(
      {
        name: "Credito personal",
        currency: Currency.COP,
        termFrequency: TermFrequency.MONTHLY,
        termInstallments: 3,
        minTermInstallments: 2,
        maxTermInstallments: 6,
        effectiveFeeBps: 1800,
        isActive: true,
      },
      NOW,
    ),
    ...overrides,
  };
}

function tier(position: number, amountPesos: number, isActive = true): ProductTierDoc {
  return buildProductTierDoc({ productCode: "MICRO", position, amountPesos, isActive }, NOW);
}

function rate(version: number, isActive: boolean): InterestRateDoc {
  return buildInterestRateDoc(
    {
      productType: "MICRO",
      annualRateBps: 2000 + version,
      maximumRateBps: 3500,
      effectiveFrom: NOW,
      source: "Resolución",
      version,
      isActive,
    },
    NOW,
  );
}

describe("ids de configuración", () => {
  it("deriva el id del tier del código y la posición", () => {
    expect(productTierDocId("MICRO", 3)).toBe("MICRO_3");
  });

  it("deriva el id de la tasa del producto y la versión", () => {
    expect(interestRateDocId("MICRO", 4)).toBe("MICRO_v4");
  });

  it("rechaza el código de producto vacío (produciría el id '_1')", () => {
    expectAppError(() => productTierDocId("", 1), ErrorCode.VALIDATION, 400);
    expectAppError(() => productTierDocId("   ", 1), ErrorCode.VALIDATION, 400);
    expectAppError(() => interestRateDocId("", 1), ErrorCode.VALIDATION, 400);
  });

  it("normaliza el código con espacios en los bordes antes de armar el id", () => {
    expect(productTierDocId(" MICRO ", 2)).toBe("MICRO_2");
  });
});

describe("escalera de montos", () => {
  it("acepta montos que crecen con la posición", () => {
    expect(() =>
      assertTierAmountsAscend([tier(1, 200_000), tier(2, 400_000), tier(3, 900_000)]),
    ).not.toThrow();
  });

  it("acepta un rung desactivado fuera de orden: no está a la venta", () => {
    expect(() =>
      assertTierAmountsAscend([tier(1, 200_000), tier(2, 400_000, false), tier(3, 250_000)]),
    ).not.toThrow();
  });

  it("rechaza que un rung activo undercut al anterior", () => {
    expect(() => assertTierAmountsAscend([tier(1, 200_000), tier(2, 150_000)])).toThrow(/crezca|mayor/i);
  });

  it("rechaza el monto repetido entre dos rungs activos", () => {
    expect(() => assertTierAmountsAscend([tier(1, 200_000), tier(2, 200_000)])).toThrow();
  });

  it("ordena por posición antes de comparar", () => {
    // El orden de la colección no está garantizado: comparar en el orden recibido aceptaría esta
    // escalera inválida y rechazaría la válida.
    expect(() => assertTierAmountsAscend([tier(2, 400_000), tier(1, 200_000)])).not.toThrow();
    expect(() => assertTierAmountsAscend([tier(2, 150_000), tier(1, 200_000)])).toThrow();
  });
});

describe("producto activo necesita catálogo", () => {
  it("acepta un producto activo con al menos un tier activo", () => {
    expect(() => assertProductHasActiveTier(product(), [tier(1, 200_000), tier(2, 400_000, false)])).not.toThrow();
  });

  it("rechaza activar un producto sin ningún tier activo", () => {
    expectAppError(
      () => assertProductHasActiveTier(product({ isActive: true }), [tier(1, 200_000, false)]),
      ErrorCode.CONFLICT,
      409,
    );
  });

  it("permite desactivar el producto aunque se quede sin tiers activos", () => {
    expect(() =>
      assertProductHasActiveTier(product({ isActive: false }), [tier(1, 200_000, false)]),
    ).not.toThrow();
  });
});

describe("producto activo necesita tasa activa", () => {
  it("acepta desactivar una tasa si queda otra activa", () => {
    expect(() =>
      assertProductKeepsActiveRate(product(), [rate(1, false), rate(2, true), rate(3, false)]),
    ).not.toThrow();
  });

  it("rechaza desactivar la única tasa activa de un producto activo", () => {
    expectAppError(
      () => assertProductKeepsActiveRate(product(), [rate(1, false), rate(2, false)]),
      ErrorCode.CONFLICT,
      409,
    );
  });

  it("permite quedarse sin tasa activa si el producto se desactiva", () => {
    expect(() =>
      assertProductKeepsActiveRate(product({ isActive: false }), [rate(1, false)]),
    ).not.toThrow();
  });
});

describe("versionado de tasas", () => {
  it("empieza en 1 sin tasas", () => {
    expect(nextRateVersion([])).toBe(1);
  });

  it("usa el máximo de las tasas que le pasan (el servicio ya filtró por producto)", () => {
    // `nextRateVersion` no mira `productType`: el servicio le pasa lo que devolvió la consulta
    // `where("productType", "==", code)`. Por eso el contrato es "el máximo de estas", y el test
    // documenta esa dependencia en vez de fingir que filtra.
    expect(nextRateVersion([rate(1, false), rate(2, false), rate(7, true)])).toBe(8);
  });
});

describe("umbrales de mora", () => {
  it("acepta la escalera 3/15/30", () => {
    expect(parseThresholdsForWrite({ dueSoonDays: 3, overdueDays: 15, defaultDays: 30 })).toEqual({
      dueSoonDays: 3,
      overdueDays: 15,
      defaultDays: 30,
    });
  });

  it("rechaza que la ventana de aviso llegue al atraso", () => {
    // Con `dueSoonDays >= overdueDays` el motor clasifica una cuota ya vencida como `DUE_SOON`.
    expectAppError(
      () => parseThresholdsForWrite({ dueSoonDays: 20, overdueDays: 15, defaultDays: 30 }),
      ErrorCode.VALIDATION,
      400,
    );
    expectAppError(
      () => parseThresholdsForWrite({ dueSoonDays: 15, overdueDays: 15, defaultDays: 30 }),
      ErrorCode.VALIDATION,
      400,
    );
  });

  it("permite que la mora empiece el mismo día que la ventana de aviso cierra", () => {
    // `defaultDays >= overdueDays` lo acepta el motor y es legítimo: sin ventana de solo "vencido",
    // el préstamo salta de CURRENT a DEFAULT el día del atraso.
    expect(parseThresholdsForWrite({ dueSoonDays: 3, overdueDays: 15, defaultDays: 15 })).toEqual({
      dueSoonDays: 3,
      overdueDays: 15,
      defaultDays: 15,
    });
  });

  it("rechaza que la mora empiece antes de vencerse", () => {
    expectAppError(
      () => parseThresholdsForWrite({ dueSoonDays: 3, overdueDays: 15, defaultDays: 10 }),
      ErrorCode.VALIDATION,
      400,
    );
  });

  it("rechaza días negativos o no enteros", () => {
    expectAppError(
      () => parseThresholdsForWrite({ dueSoonDays: -1, overdueDays: 15, defaultDays: 30 }),
      ErrorCode.VALIDATION,
      400,
    );
    expectAppError(
      () => parseThresholdsForWrite({ dueSoonDays: 1.5, overdueDays: 15, defaultDays: 30 }),
      ErrorCode.VALIDATION,
      400,
    );
  });
});

describe("canales de pago", () => {
  it("rechaza activar un canal sin nombre", () => {
    expectAppError(() => assertChannelStaysPublishable("  ", true), ErrorCode.VALIDATION, 400);
  });

  it("permite un canal inactivo sin nombre (no se muestra a nadie)", () => {
    expect(() => assertChannelStaysPublishable("  ", false)).not.toThrow();
  });

  it("escribe solo claves públicas en el allowlist", () => {
    expect(isPublicPaymentChannelMetaKey("bankName")).toBe(true);
    expect(isPublicPaymentChannelMetaKey("demo")).toBe(false);
    expect(isPublicPaymentChannelMetaKey("legalReview")).toBe(false);
  });

  it("conserva el meta ajeno al allowlist al editar", () => {
    // `meta` es un record abierto en el schema; el servicio no puede borrar lo que no conoce.
    const merged = mergeChannelMeta({ demo: true, legalReview: PAYMENT_CHANNEL_LEGAL_REVIEW_DEMO }, {
      publicMeta: { bankName: "Nequi" },
    });
    expect(merged).toMatchObject({
      demo: true,
      legalReview: PAYMENT_CHANNEL_LEGAL_REVIEW_DEMO,
      bankName: "Nequi",
    });
  });

  it("marca demo pendiente de revisión legal cuando el canal vuelve a demo", () => {
    const merged = mergeChannelMeta({ legalReview: PAYMENT_CHANNEL_LEGAL_REVIEW_DEMO }, {
      publicMeta: {},
      dataReplaced: false,
    });
    expect(merged).toMatchObject({
      demo: true,
      legalReview: PAYMENT_CHANNEL_LEGAL_REVIEW_DEMO,
    });
  });

  it("reemplazar los datos del banco borra la marca demo y deja revisión legal pendiente", () => {
    const merged = mergeChannelMeta({ demo: true, legalReview: PAYMENT_CHANNEL_LEGAL_REVIEW_DEMO }, {
      publicMeta: { accountNumber: "123" },
      dataReplaced: true,
    });
    expect(merged).toMatchObject({
      accountNumber: "123",
      legalReview: PAYMENT_CHANNEL_LEGAL_REVIEW_REPLACED,
    });
    expect(merged.demo).toBeUndefined();
  });

  it("no inventa `dataReplaced` si el parche no lo menciona", () => {
    const merged = mergeChannelMeta({ demo: true }, { publicMeta: { bankName: "Bancolombia" } } as PaymentChannelMetaPatch);
    expect(merged).toEqual({ demo: true, bankName: "Bancolombia" });
  });
});

describe("diff de auditoría", () => {
  it("marca solo los campos que cambian", () => {
    const changes = diffConfigFields(
      { name: "A", isActive: true, termFrequency: TermFrequency.MONTHLY },
      { name: "B", isActive: true, termFrequency: TermFrequency.MONTHLY },
      ["name", "isActive", "termFrequency"],
    );
    expect(changes).toEqual([{ field: "name", before: "A", after: "B" }]);
  });

  it("detecta volver un booleano a false", () => {
    const changes = diffConfigFields({ isActive: true }, { isActive: false }, ["isActive"]);
    expect(changes).toEqual([{ field: "isActive", before: true, after: false }]);
  });

  it("distingue ausente de false (un campo opcional no es `false`)", () => {
    // El bug clásico: `Boolean(antes) === Boolean(después)` declara "sin cambios" cuando el campo
    // simplemente no venía, y el guardado se pierde en silencio.
    const changes = diffConfigFields({ name: undefined }, { name: undefined }, ["name"]);
    expect(changes).toEqual([]);
    expect(diffConfigFields({ name: "A" }, { name: undefined }, ["name"])).toEqual([
      { field: "name", before: "A", after: null },
    ]);
  });

  it("no toca los campos fuera de la lista", () => {
    const changes = diffConfigFields({ name: "A", updatedAt: NOW }, { name: "A", updatedAt: LATER }, ["name"]);
    expect(changes).toEqual([]);
  });
});

describe("tipos de entidad auditada", () => {
  it("son los que el enum de auditoría ya acepta", () => {
    // Si `AuditAction.CONFIG_CHANGED` no acepta un entityType, el write de auditoría revienta en
    // producción; el tipo lo compila, pero esta aserción documenta el contrato.
    expect(Object.values(CONFIG_ENTITY_TYPES).every((value) => typeof value === "string")).toBe(true);
    expect(CONFIG_ENTITY_TYPES).toMatchObject({
      product: expect.any(String),
      tier: expect.any(String),
      rate: expect.any(String),
      thresholds: expect.any(String),
      channel: expect.any(String),
    });
  });
});