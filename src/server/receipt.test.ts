import { describe, expect, it } from "vitest";
import {
  MAX_RECEIPT_BYTES,
  buildReceiptReference,
  detectReceiptFamily,
  newReceiptPublicId,
  parseReceiptReference,
  receiptExtensionOf,
  validateReceipt,
  type ReceiptCandidate,
} from "./receipt";

/** Bytes reales mínimos: la validación mira la firma, no la extensión. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);

function archivo(over: Partial<ReceiptCandidate> = {}): ReceiptCandidate {
  return { filename: "comprobante.png", declaredType: "image/png", bytes: PNG, ...over };
}

function capture(fn: () => unknown): { message: string; statusCode?: number } {
  try {
    fn();
  } catch (error) {
    const e = error as { message: string; statusCode?: number };
    return { message: e.message, statusCode: e.statusCode };
  }
  throw new Error("se esperaba un error y no hubo");
}

describe("receiptExtensionOf", () => {
  it("acepta la lista corta de §11 y normaliza a minúsculas", () => {
    expect(receiptExtensionOf("comprobante.PNG")).toBe("png");
    expect(receiptExtensionOf("captura.JPEG")).toBe("jpeg");
    expect(receiptExtensionOf("recibo.pdf")).toBe("pdf");
    expect(receiptExtensionOf("foto.jpg")).toBe("jpg");
  });

  it("rechaza lo que no está en la lista, incluidos los que solo parecen válidos", () => {
    expect(receiptExtensionOf("script.exe")).toBeNull();
    expect(receiptExtensionOf("comprobante")).toBeNull();
    expect(receiptExtensionOf(".png")).toBeNull();
    expect(receiptExtensionOf("comprobante.png.exe")).toBeNull();
  });
});

describe("detectReceiptFamily", () => {
  it("reconoce las tres familias por sus bytes", () => {
    expect(detectReceiptFamily(PNG)).toBe("png");
    expect(detectReceiptFamily(JPEG)).toBe("jpeg");
    expect(detectReceiptFamily(PDF)).toBe("pdf");
  });

  it("no se deja engañar por un GIF ni por un archivo vacío o corto", () => {
    expect(detectReceiptFamily(GIF)).toBeNull();
    expect(detectReceiptFamily(new Uint8Array([]))).toBeNull();
    expect(detectReceiptFamily(new Uint8Array([0x89, 0x50]))).toBeNull();
  });
});

describe("validateReceipt", () => {
  it("acepta un PNG coherente en nombre, tipo y bytes", () => {
    const r = validateReceipt(archivo());
    expect(r.contentType).toBe("image/png");
    expect(r.extension).toBe("png");
    expect(r.byteLength).toBe(PNG.length);
  });

  it("acepta .jpeg e image/jpg, que es como lo declara un navegador real", () => {
    const r = validateReceipt(
      archivo({ filename: "COMPROBANTE.JPEG", declaredType: "image/jpg", bytes: JPEG }),
    );
    expect(r.contentType).toBe("image/jpeg");
    expect(r.extension).toBe("jpeg");
  });

  it("no exige un Content-Type informado: los bytes deciden", () => {
    // Chrome en algunos SO envía application/octet-stream; rechazarlo sería rechazar pruebas
    // legítimas sin ganar nada en seguridad.
    expect(validateReceipt(archivo({ declaredType: "application/octet-stream" })).contentType).toBe(
      "image/png",
    );
    expect(validateReceipt(archivo({ declaredType: "" })).contentType).toBe("image/png");
  });

  it("rechaza un archivo vacío", () => {
    expect(capture(() => validateReceipt(archivo({ bytes: new Uint8Array([]) })))).toEqual(
      expect.objectContaining({ message: "El comprobante está vacío" }),
    );
  });

  it("rechaza lo que pasa de 5 MB, sin dejar que el número sea el límite real", () => {
    const grande = new Uint8Array(MAX_RECEIPT_BYTES + 1);
    grande.set(PNG);
    const error = capture(() => validateReceipt(archivo({ bytes: grande })));
    expect(error.statusCode).toBe(400);
    expect(error.message).toContain("5 MB");
  });

  it("acepta exactamente 5 MB: el límite es inclusivo", () => {
    const justo = new Uint8Array(MAX_RECEIPT_BYTES);
    justo.set(PNG);
    expect(validateReceipt(archivo({ bytes: justo })).byteLength).toBe(MAX_RECEIPT_BYTES);
  });

  it("rechaza una extensión fuera de la allowlist", () => {
    expect(capture(() => validateReceipt(archivo({ filename: "comprobante.gif" }))).message).toContain(
      ".png, .jpg, .jpeg o .pdf",
    );
  });

  it("rechaza un contenido que no es imagen ni PDF aunque se llame .png", () => {
    const error = capture(() =>
      validateReceipt(archivo({ declaredType: "image/png", bytes: GIF })),
    );
    expect(error.statusCode).toBe(400);
    expect(error.message).toContain("no es un PNG, un JPEG ni un PDF");
  });

  it("rechaza la extensión que no concuerda con los bytes (PDF disfrazado de .png)", () => {
    // Es el caso que hace necesaria la firma binaria: el Content-Type y el nombre dicen PNG.
    const error = capture(() =>
      validateReceipt(
        archivo({ filename: "comprobante.png", declaredType: "image/png", bytes: PDF }),
      ),
    );
    expect(error.statusCode).toBe(400);
    expect(error.message).toContain("extensión .png pero su contenido es PDF");
  });

  it("rechaza un Content-Type que contradice los bytes", () => {
    const error = capture(() =>
      validateReceipt(archivo({ declaredType: "text/html", bytes: PNG })),
    );
    expect(error.statusCode).toBe(400);
    expect(error.message).toContain("se declaró como text/html");
  });

  it("rechaza un SVG, que es un documento que se puede ejecutar", () => {
    // No está en la allowlist de §11, pero el caso merece quedar escrito: un SVG subido como
    // imagen y servido desde el mismo dominio es un XSS esperando a happen.
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
    expect(capture(() => validateReceipt(archivo({ filename: "x.svg", bytes: svg })))).toEqual(
      expect.objectContaining({ statusCode: 400 }),
    );
  });
});

describe("referencia del comprobante", () => {
  const paymentNumber = "PAY-2026-0001";

  it("el public_id es aleatorio y vive bajo la carpeta del pago", () => {
    const a = newReceiptPublicId(paymentNumber);
    const b = newReceiptPublicId(paymentNumber);
    expect(a).not.toBe(b);
    expect(a.startsWith(`microcredito/payments/${paymentNumber}/`)).toBe(true);
  });

  it("lo que se guarda es una ruta sin firma, que no sirve para descargar nada", () => {
    const ref = buildReceiptReference({
      publicId: newReceiptPublicId(paymentNumber),
      format: "png",
    });
    expect(ref).toMatch(
      /^image\/authenticated\/microcredito\/payments\/PAY-2026-0001\/[0-9a-f-]{36}\.png$/,
    );
    // Sin el componente s--firma-- el CDN no entrega el asset: por eso el campo es inocuo.
    expect(ref).not.toContain("s--");
  });

  it("reconstruye public_id y formato para poder firmarlo", () => {
    const publicId = newReceiptPublicId(paymentNumber);
    const parsed = parseReceiptReference(buildReceiptReference({ publicId, format: "pdf" }), paymentNumber);
    expect(parsed).toEqual({ publicId, format: "pdf" });
  });

  it("no firma una referencia que no es de este pago", () => {
    const otroPago = buildReceiptReference({
      publicId: newReceiptPublicId("PAY-2026-0002"),
      format: "png",
    });
    expect(parseReceiptReference(otroPago, paymentNumber)).toBeNull();
  });

  it("devuelve null ante cualquier referencia escrita a mano", () => {
    const casos = [
      "",
      "https://res.cloudinary.com/demo/image/upload/malo.png",
      "image/upload/microcredito/payments/PAY-2026-0001/x.png",
      "image/authenticated/microcredito/payments/PAY-2026-0001/no-es-uuid.png",
      "image/authenticated/microcredito/payments/PAY-2026-0001/x.png/../../otra.png",
      `image/authenticated/microcredito/payments/${paymentNumber}/../../../../etc/passwd`,
    ];
    for (const caso of casos) {
      expect(parseReceiptReference(caso, paymentNumber), caso).toBeNull();
    }
  });
});
