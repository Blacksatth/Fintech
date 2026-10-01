import { randomUUID } from "node:crypto";

/**
 * Comprobantes de pago (PROJECT_SPEC §11, F10-3).
 *
 * Dominio puro: sin Next, sin Firebase y sin Cloudinary. Aquí vive **qué** es un comprobante
 * aceptable (allowlist de extensión y MIME, ≤5 MB, firma binaria) y **cómo se referencia** el
 * archivo ya subido; el transporte (subida, entrega firmada, borrado) es una implementación de
 * `ReceiptStore` que vive en el servidor.
 *
 * **Un comprobante nunca paga.** Adjuntar uno no mueve el estado del pago: eso es la confirmación
 * humana de F10-2b. Lo único que hace este archivo es decidir si lo que el cliente envió se
 * acepta como evidencia.
 */

/** §11: "≤5 MB". Es un límite de la evidencia que se sube, no del cuerpo HTTP. */
export const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;

/**
 * Vida de la URL firmada que se entrega al leer un comprobante. Corta a propósito: la URL es una
 * credencial temporal y el comprobante se ve en un clic, no se archiva.
 */
export const RECEIPT_URL_TTL_SECONDS = 5 * 60;

export type ReceiptExtension = "png" | "jpg" | "jpeg" | "pdf";
export type ReceiptContentType = "image/png" | "image/jpeg" | "application/pdf";

/** Familias binarias: lo que los **bytes** dicen, que es lo único en lo que se confía. */
type ReceiptFamily = "png" | "jpeg" | "pdf";

const EXTENSION_FAMILY: Record<ReceiptExtension, ReceiptFamily> = {
  png: "png",
  jpg: "jpeg",
  jpeg: "jpeg",
  pdf: "pdf",
};

const FAMILY_CONTENT_TYPE: Record<ReceiptFamily, ReceiptContentType> = {
  png: "image/png",
  jpeg: "image/jpeg",
  pdf: "application/pdf",
};

/** Los tipos que un navegador declara y que sabemos interpretar. `image/jpg` no es un tipo real. */
const DECLARED_TYPES: Record<string, ReceiptFamily> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "application/pdf": "pdf",
};

/**
 * `true` cuando el navegador no nos dice nada utilizable. No es permiso: los bytes siguen siendo
 * los que deciden, y un `application/octet-stream` con bytes de PNG es un PNG.
 */
const UNINFORMATIVE_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream"]);

const MAGIC_BYTES: Record<ReceiptFamily, readonly number[]> = {
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  jpeg: [0xff, 0xd8, 0xff],
  pdf: [0x25, 0x50, 0x44, 0x46],
};

export class ReceiptError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "ReceiptError";
    this.statusCode = statusCode;
  }
}

export interface ReceiptCandidate {
  /** Nombre que declaró el cliente. **No es confiable**: solo se usa para la extensión. */
  filename: string;
  /** `Content-Type` declarado. Se cruza con los bytes, no se acepta como verdad. */
  declaredType: string;
  bytes: Uint8Array;
}

export interface ValidatedReceipt {
  extension: ReceiptExtension;
  contentType: ReceiptContentType;
  byteLength: number;
  bytes: Uint8Array;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

/** Familia según los primeros bytes, o `null` si el archivo no es de ninguna que aceptamos. */
export function detectReceiptFamily(bytes: Uint8Array): ReceiptFamily | null {
  for (const [family, signature] of Object.entries(MAGIC_BYTES) as Array<
    [ReceiptFamily, readonly number[]]
  >) {
    if (startsWith(bytes, signature)) return family;
  }
  return null;
}

/** Extensión en minúsculas, sin el punto. `null` si el nombre no trae una extensión usable. */
export function receiptExtensionOf(filename: string): ReceiptExtension | null {
  const dot = filename.lastIndexOf(".");
  if (dot < 1) return null;
  const extension = filename.slice(dot + 1).toLowerCase();
  const known = Object.keys(EXTENSION_FAMILY) as ReceiptExtension[];
  return known.includes(extension as ReceiptExtension) ? (extension as ReceiptExtension) : null;
}

/**
 * Validación severa (así lo pide §11) y en tres capas, porque cada una tapa un agujero distinto:
 *
 * 1. **Tamaño**: nada de comprobantes vacíos ni de 40 MB disfrazados de PDF.
 * 2. **Extensión**: la lista corta de §11. Un `.exe` no llega ni a Firestore.
 * 3. **Bytes**: la firma binaria tiene que decir `png`, `jpeg` o `pdf` **y** tener que concordar
 *    con la extensión y con el `Content-Type` declarado. Un archivo con doble firma (polyglot) o
 *    con extensión `.png` y contenido de PDF es exactamente lo que esta regla rechaza; si solo
 *    miráramos el `Content-Type`, un atacante pondría `image/png` y subió lo que quisiera.
 */
export function validateReceipt(candidate: ReceiptCandidate): ValidatedReceipt {
  const { bytes, filename, declaredType } = candidate;

  if (bytes.length === 0) {
    throw new ReceiptError("El comprobante está vacío");
  }
  if (bytes.length > MAX_RECEIPT_BYTES) {
    throw new ReceiptError(
      `El comprobante pesa ${(bytes.length / (1024 * 1024)).toFixed(1)} MB y el máximo es 5 MB`,
    );
  }

  const extension = receiptExtensionOf(filename);
  if (!extension) {
    throw new ReceiptError("El comprobante debe ser un archivo .png, .jpg, .jpeg o .pdf");
  }

  const family = detectReceiptFamily(bytes);
  if (!family) {
    throw new ReceiptError(
      "El contenido del archivo no es un PNG, un JPEG ni un PDF (se verificó la firma del archivo)",
    );
  }

  if (EXTENSION_FAMILY[extension] !== family) {
    throw new ReceiptError(
      `El archivo tiene extensión .${extension} pero su contenido es ${family.toUpperCase()}`,
    );
  }

  const declaredFamily = DECLARED_TYPES[declaredType.trim().toLowerCase()];
  if (!UNINFORMATIVE_TYPES.has(declaredType.trim().toLowerCase()) && declaredFamily !== family) {
    throw new ReceiptError(
      `El comprobante se declaró como ${declaredType} y su contenido es ${FAMILY_CONTENT_TYPE[family]}`,
    );
  }

  return {
    extension,
    contentType: FAMILY_CONTENT_TYPE[family],
    byteLength: bytes.length,
    bytes,
  };
}

/** ==================== Transporte ==================== */

/**
 * Lo que hay que poder hacer con un comprobante, sin saber quién lo guarda.
 *
 * La interfaz vive aquí (y no junto a la implementación de Cloudinary) para que el servicio de
 * pagos pueda probarse con un doble en memoria y para que cambiar de proveedor no toque la
 * lógica de negocio. La implementación real está en `src/server/cloudinary.ts`.
 */
export interface ReceiptStore {
  /** Sube el archivo y devuelve cómo quedó guardado. Lanza si el proveedor falla. */
  upload(input: {
    publicId: string;
    bytes: Uint8Array;
    contentType: ReceiptContentType;
  }): Promise<{ publicId: string; format: string }>;
  /**
   * URL **firmada** con caducidad, servible sin credenciales. Es lo único que se le entrega a un
   * humano: sin firma, el asset `authenticated` no se entrega.
   */
  signedDeliveryUrl(reference: ReceiptReference, ttlSeconds: number): string;
  /** Borra el archivo (reemplazar un comprobante, deshacer una subida que no llegó a Firestore). */
  destroy(reference: ReceiptReference): Promise<void>;
}

/** Error del proveedor de almacenamiento: no es culpa de quien subió el archivo. */
export class ReceiptStorageError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 502) {
    super(message);
    this.name = "ReceiptStorageError";
    this.statusCode = statusCode;
  }
}

/** ==================== Referencia del archivo subido ==================== */

/**
 * Raíz de las carpetas de comprobantes. El nombre del pago va en la ruta para que un operador
 * pueda encontrar el archivo desde la consola de Cloudinary sin consultar la base de datos.
 */
export const RECEIPT_FOLDER = "microcredito/payments";

/** Todos los comprobantes (incluido el PDF) se entregan como `image`: así los sirve Cloudinary. */
export const RECEIPT_RESOURCE_TYPE = "image";

/** Longitud de `randomUUID()` en formato canónico: el `public_id` siempre es `<uuid>.<formato>`. */
const UUID_LENGTH = 36;

export interface ReceiptReference {
  publicId: string;
  format: string;
}

/**
 * `public_id` **aleatorio** (§11: "nombre aleatorio") bajo la carpeta del pago.
 *
 * El UUID evita adivinar el nombre de un comprobante ajeno, y el prefijo del número de pago hace
 * que un archivo se pueda rastrear sin un índice. No lleva extensión: Cloudinary guarda el formato
 * aparte y lo devuelve en la respuesta de la subida.
 */
export function newReceiptPublicId(paymentNumber: string): string {
  return `${RECEIPT_FOLDER}/${paymentNumber}/${randomUUID()}`;
}

/**
 * Lo que se guarda en `payments.receiptUrl`: la **ruta de entrega sin firma**.
 *
 * Sin firma, esa ruta no descarga nada (el asset es `authenticated`: sin `s--firma--` el CDN
 * responde error), y por eso es inocua guardarla en el documento: sirve para diagnóstico, no
 * para leer el comprobante. La URL que sí entrega el archivo la firma el servidor bajo demanda en
 * `GET /api/payments/:id/receipt`, con caducidad corta.
 */
export function buildReceiptReference(reference: ReceiptReference): string {
  return `${RECEIPT_RESOURCE_TYPE}/authenticated/${reference.publicId}.${reference.format}`;
}

/**
 * Lee una referencia escrita por `buildReceiptReference` para poder firmarla.
 *
 * Es deliberadamente estricta y devuelve `null` ante cualquier cosa inesperada: quien llama
 * prefiere un `null` (y un error 500 honesto) antes que firmar un `public_id` arbitrario que
 * alguien haya escrito a mano en el documento. Además exige que el `public_id` viva bajo la
 * carpeta de **este** pago, así un documento manipulado no puede hacer que se firme el comprobante
 * de otro.
 */
export function parseReceiptReference(
  raw: string,
  paymentNumber: string,
): ReceiptReference | null {
  const prefix = `${RECEIPT_RESOURCE_TYPE}/authenticated/${RECEIPT_FOLDER}/${paymentNumber}/`;
  if (!raw.startsWith(prefix)) return null;

  const rest = raw.slice(prefix.length);
  const dot = rest.indexOf(".");
  // Lo que sigue al prefijo es `<uuid de 36 chars>.<formato>` y nada más: ni una barra, ni un
  // punto extra, ni un nombre de archivo elegido por un documento.
  if (dot !== UUID_LENGTH) return null;

  const fileName = rest.slice(0, dot);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fileName)) return null;

  const format = rest.slice(dot + 1);
  if (!/^[a-z0-9]+$/.test(format)) return null;

  return { publicId: `${RECEIPT_FOLDER}/${paymentNumber}/${fileName}`, format };
}
