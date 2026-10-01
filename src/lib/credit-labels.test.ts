import { describe, expect, it } from "vitest";
import { formatDueDate, installmentStatusLabel, loanStatusLabel, termFrequencyLabel } from "./credit-labels";

describe("formatDueDate", () => {
  it("muestra el día del vencimiento UTC, no el día local", () => {
    // Medianoche UTC del 24/03. En UTC-5 (Colombia) el navegador lo vería como 23/03 19:00.
    expect(formatDueDate("2026-03-24T00:00:00.000Z")).toBe("24/03/2026");
  });

  it("no corre el vencimiento un dia por el offset positivo", () => {
    expect(formatDueDate("2026-01-01T00:00:00.000Z")).toBe("01/01/2026");
  });

  it("acepta Date, ISO y epoch", () => {
    expect(formatDueDate(new Date("2026-03-24T00:00:00.000Z"))).toBe("24/03/2026");
    expect(formatDueDate(Date.parse("2026-03-24T00:00:00.000Z"))).toBe("24/03/2026");
  });

  it("devuelve el fallback si no hay fecha", () => {
    expect(formatDueDate(null)).toBe("—");
    expect(formatDueDate(undefined, "n/d")).toBe("n/d");
  });
});

describe("etiquetas de prestamos y cuotas", () => {
  it("traduce los estados de prestamo a texto legible", () => {
    expect(loanStatusLabel("PENDING_DISBURSEMENT")).toBe("Pendiente de desembolso");
    expect(loanStatusLabel("PAID")).toBe("Pagado");
  });

  it("traduce el estado de cuota", () => {
    expect(installmentStatusLabel("PENDING")).toBe("Pendiente");
    expect(installmentStatusLabel("PAID")).toBe("Pagada");
  });

  it("traduce la frecuencia", () => {
    expect(termFrequencyLabel("BIWEEKLY")).toBe("Quincenal");
  });
});
