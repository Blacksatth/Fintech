export function assertSafeInteger(value: number, context?: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(
      `Valor no es entero seguro: ${String(value)}${context ? ` en ${context}` : ""}`,
    );
  }
  return value;
}

export function add(a: number, b: number): number {
  return assertSafeInteger(assertSafeInteger(a, "add(a)") + assertSafeInteger(b, "add(b)"), "add(a+b)");
}

export function sub(a: number, b: number): number {
  return assertSafeInteger(assertSafeInteger(a, "sub(a)") - assertSafeInteger(b, "sub(b)"), "sub(a-b)");
}

export function mul(a: number, b: number): number {
  return assertSafeInteger(assertSafeInteger(a, "mul(a)") * assertSafeInteger(b, "mul(b)"), "mul(a*b)");
}

export function div(n: number, d: number): number {
  if (!Number.isSafeInteger(d) || d <= 0) {
    throw new RangeError("div: el divisor debe ser un entero positivo");
  }
  return assertSafeInteger(Math.floor(assertSafeInteger(n, "div(n)") / d), "div(n/d)");
}

export function divMod(n: number, d: number): { quotient: number; remainder: number } {
  const quotient = div(n, d);
  return { quotient, remainder: n - quotient * d };
}

/**
 * Division redondeada al entero mas cercano, con .5 ALEJANDOSE DEL CERO. Es la primitiva
 * para aritmetica de basis points: `roundDiv(50000 * 2400, 10000)`.
 *
 * El signo se trata por separado porque `div` trunca hacia -inf (el residuo siempre sale
 * >= 0), y eso invertiria el redondeo en negativos. El producto intermedio se valida como
 * entero seguro, asi que un desborde falla en vez de perder precision en silencio.
 */
export function roundDiv(n: number, d: number): number {
  if (!Number.isSafeInteger(d) || d <= 0) {
    throw new RangeError("roundDiv: el divisor debe ser un entero positivo");
  }
  const numerator = assertSafeInteger(n, "roundDiv(n)");
  const magnitude = numerator < 0 ? -numerator : numerator;
  const { quotient, remainder } = divMod(magnitude, d);
  const rounded = remainder * 2 >= d ? add(quotient, 1) : quotient;
  return assertSafeInteger(numerator < 0 ? -rounded : rounded, "roundDiv(n/d)");
}

const copFormatter = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

export function formatPesos(n: number): string {
  return copFormatter.format(assertSafeInteger(n, "formatPesos"));
}

/**
 * Presenta un importe que puede **no existir**. En el proyecto real hay documentos de `loans`
 * anteriores al esquema actual que solo guardan `userId`, `status` y `createdAt`: sin esto,
 * `formatPesos(undefined)` tumba la pantalla admin entera.
 *
 * No relaja la invariante de dinero. Quien *opera* sobre importes (desembolso, pagos) sigue
 * exigiendo enteros seguros; esto solo decide qué mostrar cuando el dato no está.
 */
export function formatPesosOrDash(value: unknown): string {
  return typeof value === "number" && Number.isSafeInteger(value) ? formatPesos(value) : "—";
}