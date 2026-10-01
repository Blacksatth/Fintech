# PROJECT_SPEC — Plataforma de Microcréditos (Colombia)

**Documento vivo.** Fecha de creación: 2026-09-24. Actualizado: 2026-09-25 (v3: conexión directa a
proyecto real `credito-a1b4a` sin emuladores; imágenes/comprobantes con **Cloudinary**, sin Firebase Storage).
Estado: **pendiente de aprobación**. Se actualiza antes que el código cuando cambian decisiones.

---

## 1. Resumen ejecutivo

Plataforma web que otorga microcréditos en Colombia usando **únicamente capital propio**, construida
como **producto real orientado a salir al mercado**. La fase actual (MVP) cubre el ciclo completo:
registro → perfil → solicitud → scoring por reglas → aprobación/rechazo → préstamo y cuotas →
desembolso manual → registro y confirmación de pagos → mora → dashboards cliente/admin → auditoría →
notificaciones → métricas de cartera.

El MVP no integra dinero real ni proveedores de pago: los montos, instrucciones de transferencia y
confirmaciones son operados por un administrador. La arquitectura deja interfaces
(`PaymentProvider`, `DisbursementProvider`, `RiskEngine`, `NotificationProvider`) listas para
sustitución posterior y para producción.

La base de datos es **Firebase Firestore** + **Firebase Auth**, en conexión **directa al proyecto real
`credito-a1b4a`** (sin emuladores). Imágenes (comprobantes de pago) vía **Cloudinary** con entrega
restringida; **sin Firebase Storage**. La moneda se maneja en **pesos enteros (COP)**, sin céntimos.
Decisiones de arquitectura: **Next.js 16.3.6** + **TypeScript strict** + **Firebase**. Proyecto nuevo:
**`microcredito/`** dentro del repo `react`.

---

## 2. Objetivo

Producto que demuestre el flujo completo de microcrédito con control administrativo, seguridad,
idempotencia y auditoría, trazable hacia una operación comercial real. Éxito = un usuario pasa de
registro hasta una cuota confirmada como pagada por un administrador, con todo el movimiento auditado,
explicable y reproducible (tests), sobre infraestructura lista para escalar a producción (Firebase).

---

## 3. Alcance

### 3.1 Incluido (MVP)
1. Registro e inicio de sesión seguro (Firebase Auth + session cookies).
2. Perfil de solicitante (datos mínimos).
3. Solicitud de préstamo.
4. Scoring por reglas (explicable), sin ML.
5. Aprobación / rechazo por administrador.
6. Creación de préstamo y generación de cuotas.
7. Desembolso manual controlado por administrador.
8. Registro de pago del cliente → PENDING → confirmado por admin → cuota actualizada.
9. Consulta de estado del préstamo e historial de pagos.
10. Gestión administrativa (solicitudes, préstamos, pagos, usuarios).
11. Control de mora (estados y `days_past_due`).
12. Notificaciones (bandeja in-app + log; email con proveedor configurable, sin credenciales reales).
13. Auditoría de operaciones críticas (append-only).
14. Dashboard financiero y métricas de cartera.
15. Configuración administrable (productos/tiers, tasas, umbrales, canales de pago).
16. Arquitectura preparada para `PaymentProvider`/`Webhook`/`Reconciliation` y proveedores de
    desembolso/notificación futuros.

### 3.2 Excluido de este MVP (etapa siguiente, sin implementar ahora)
- Inversionistas externos, marketplace, crowdfunding, préstamos entre usuarios, tarjetas, Open Banking.
- ML para aprobación.
- Integración real de dinero: Wompi / MercadoPago / Bre-B, webhooks, credenciales reales.
- KYC formal; evasión de límites legales; cobranza agresiva; scraping de datos personales.
- Despliegue comercial activo y cobranza con terceros. n8n queda para después del MVP.
- Producción financiera plena: requiere revisión jurídica y proveedores reales (ver §21).

> Ser "producto real para salir al mercado" NO implica saltarse controles: el MVP sigue sin codificar
> verdades legales y sin marcar pagos automáticamente. Ese es precisamente el estándar de producción.

---

## 4. Usuarios y roles

### 4.1 Roles iniciales
| Rol | Permisos |
|---|---|
| `CUSTOMER` | Ver perfil, solicitar préstamo, ver préstamo/cuotas, registrar pago, ver historial, ver notificaciones. |
| `ADMIN` | Dashboard, usuarios, solicitudes, análisis de riesgo, aprobar/rechazar, préstamos, desembolsos, pagos, mora, cartera, configuración, auditoría. |

- RBAC verificado **en backend** por ruta (nunca en frontend). El rol se lee del documento
  `users/{uid}` (fuente de verdad) vía Admin SDK en servidor. Enumerado extensible a
  `RISK_ANALYST`, `COLLECTION_AGENT`, `SUPER_ADMIN`; solo se crean las dos primeras.
- Roles del sistema (actor para auditoría): `USER`, `ADMIN`, `SYSTEM`, `SEED`.

---

## 5. Funcionalidades por mapa de capacidades

| Módulo | Responsabilidad | Depende de |
|---|---|---|
| `foundation` | Config/env Firebase, Admin SDK, emuladores, dinero, idempotencia, rate limit, design system | — |
| `identity` | Registro, login, sesión, RBAC, auditoría de usuario | foundation |
| `risk` | Motor de scoring por reglas, factores, versionado | identity |
| `credit` | Productos/tiers, límites, solicitud, aprobación, préstamo, cuotas, desembolso | identity, risk |
| `payments` | Canales, registro PENDING, confirmación, eventos, idempotencia | credit |
| `portfolio` | Mora (`days_past_due`), métricas de cartera, dashboard admin | credit, payments |
| `notify` | Bandeja in-app + log/email; disparadas por eventos de dominio | identity, credit |
| `audit` | Append-only de acciones críticas | foundation |

**Orden:** foundation → identity → audit (con identity) → risk → credit → payments → portfolio →
notify (eventos) → dashboards → pruebas/browser/security/review.

> `audit` se usa transversalmente desde el inicio (la infraestructura existe en foundation y toda
> acción de negocio la invoca). `notify` se conecta a eventos a medida que existan.

---

## 6. Modelo de negocio y reglas de crédito

### 6.1 Productos y tiers
- Montos de primer/segundo/tercer préstamo **no hardcodeados**: viven como documentos `product_tiers`
  con `position` (1,2,3) y `amountPesos`.
- Seed **demo** (dato de arranque, no verdad legal): $50.000 / $75.000 / $100.000 COP.
- Reglas:
  - Un usuario solo puede tener **un préstamo activo**. En Firestore (NoSQL) no hay índices únicos
    parciales; la invariante se aplica **en transacción** (`runTransaction`), leyendo los préstamos
    activos antes de crear, y se cubre con test de condición de carrera.
  - El tier elegible se calcula por historial (préstamos pagados) y comportamiento, nunca por la
    solicitud del usuario.
  - Un préstamo incumplido bloquea o reduce el tier (regla configurable en `risk_rules`).
  - El admin puede ajustar el límite por usuario (`user_limit_overrides`) → auditado (`LIMIT_CHANGED`).
- Término por producto: **frecuencia única** (`termFrequency`; MICRO_BÁSICO = `MONTHLY`) y rango de
  cuotas `minTermInstallments`/`maxTermInstallments` (**mínimo 2**). El cliente elige **cuántas cuotas**
  dentro del rango; nunca la periodicidad.

### 6.2 Dinero — **pesos enteros (COP)** — decisión de negocio
- La moneda se maneja en **pesos colombianos enteros** (sin céntimos): cada importe es un entero COP.
- Almacenados y calculados como **enteros** (tipo `number` de Firestore), nunca `float` decimal con
  redondeo. Firestore almacena IEEE-754 doubles; los enteros son exactos mientras estén por debajo de
  `2^53 ≈ 9.007e15`. Los microcréditos están muy por debajo; aun así, `lib/money.ts` **valida
  `Number.isSafeInteger`** en toda suma/multiplicación y rechaza no-enteros (fail fast si algún día una
  agregación excede el rango seguro).
- No se usan céntimos ni fracciones: `amountPesos` es `number` entero (ej. `50000`).
- Formato de presentación legal colombiano con `Intl.NumberFormat('es-CO', { style:'currency', currency:'COP' })`
  (más `minimumFractionDigits: 0`).

### 6.3 Tasas e intereses
- `interest_rates` almacenado en Firestore (product_type, annual_rate_bps, maximum_rate_bps,
  effective_from, effective_to, source, version, is_active), **configurado, no en código**.
- **No se inventan límites legales.** Seed con `maximum_rate_bps = null`,
  `source = 'PENDING_LEGAL_REVIEW'`. Tarifa efectiva del producto en demo configurable
  (`effective_fee_bps` en product) y arranca en **0** hasta revisión jurídica de tasas/usura.
- No hay intereses de mora arbitrarios en el MVP.

### 6.4 Cuotas
- Amortización uniforme calculada en dominio puro (`server/schedule.ts`): total a pagar = principal +
  interés + tarifa (según config), repartido en cuotas iguales **en pesos enteros** (división y resto
  con enteros; el residuo se suma a la última cuota). Nada de floats.

---

## 7. Arquitectura

### 7.1 Stack (versiones verificadas 2026-09-24)
| Capa | Elección | Nota |
|---|---|---|
| Framework | **Next.js 16.3.6** (Active LTS) | Crítico: `>=16.2.0 <16.3.6` tienen RCE (GHSA-vcvr-r3jv-pc5j). **Pin exacto.** |
| UI | React 19 + Tailwind CSS v4 + App Router (RSC) | |
| Lenguaje | TypeScript (`strict: true`) | |
| Backend | Route Handlers `app/api/**` + capa de servicios/dominio | |
| **Base de datos** | **Firebase Firestore** (NoSQL) | Decisión de negocio. |
| **Auth** | **Firebase Auth** (email/password) + **session cookie** (Admin SDK) | Patrón oficial vigente. |
| Storage | **Cloudinary** (comprobantes, entrega restringida + URLs firmadas) | Sin Firebase Storage. |
| Local dev/tests | Conexión **directa al proyecto real** `credito-a1b4a` (service account) | Sin emuladores. |
| Admin SDK | **firebase-admin 14.5.0** (soporta Node 22 ≥) | Última estable (2026-09-24). |
| Tests | Vitest 5 + integración contra Firestore real; browser via `browser-automation` | |
| Env | `.env` + `lib/env.ts` (Zod) | Secrets nunca en código. |

Node local: 22.13.1 (compatible con firebase-admin y Next 16).

### 7.2 Decisiones de arquitectura clave
- **Monolito Next.js** (frontend + API) sin backend separado. Firestore + Auth vía **Admin SDK en
  servidor**; las mutaciones SIEMPRE pasan por nuestra API (el Admin SDK ignora Security Rules, el
  cliente NO). Regla: el cliente no escribe Firestore directamente en ningún flujo de negocio.
- **Autenticación Firebase => sesión**: el cliente inicia sesión con el **Web SDK de Firebase Auth**
  (email/password), obtiene un ID token y lo intercambia en `POST /api/auth/session`, donde el servidor
  llama `createSessionCookie(idToken, { expiresIn })` (máx. 14 días) y la fija como cookie HTTP-only.
  Cada request se valida con `verifySessionCookie(cookie, true)` (revocación checada). Logout revoca
  (`revokeRefreshTokens`) y borra la cookie.
- **API explícita**, no Server Actions, para toda operación que mueve dinero/estado: contratos JSON,
  idempotencia, auditoría, rate limit.
- **Dominio puro** (`src/server/**`) sin imports de Next/Firebase: la lógica que se prueba sin red
  (cuotas, scoring, mora, transiciones, dinero, idempotencia) es 100% testeable. Los servicios
  (`src/services/**`) orquestan Firestore y dominio, con `runTransaction` para invariantes.
- **Abstracciones mínimas y honestas**: `PaymentProvider`, `DisbursementProvider`, `RiskEngine`,
  `NotificationProvider` con implementaciones en desarrollo (`Manual*`, `RuleBasedRiskEngine`,
  in-app/log). No se inventa API bancaria.

### 7.3 Seguridad de datos (Firestore + Storage)
- **Security Rules**: auditoría **append-only** (`allow create, read; allow update, delete: if false`)
  y espejados de defensa para el resto de colecciones: solo lectura de colecciones públicas de
  configuración; el resto **denegado a acceso directo del cliente** (todo pasa por nuestra API).
- **Storage**: **Cloudinary** con entrega restringida; el servidor sube con la API y solo entrega URLs
  firmadas con expiración al dueño/admin al descargar un comprobante. Sin bucket de Firebase Storage.
- Backups/PITR/TTL de Firestore se consideran en la fase de despliegue (no bloquean el MVP).

### 7.4 Estructura de carpetas (la crea FASE 3)
```
microcredito/
  PROJECT_SPEC.md / IMPLEMENTATION_PLAN.md / AGENTS.md
  firebase.json / .firebaserc          # proyecto real + reglas
  firestore.rules / firestore.indexes.json      # Storage rules fuera: Cloudinary
  .env.example / .env (gitignored)              # incluye CLOUDINARY_*
  scripts/seed.ts                     # seed (admin + producto + tiers + canales)
  scripts/deploy-firebase.ts          # publica rules/índices con el service account
  src/
    app/
      (marketing)/                     # landing pública
      (auth)/login,register            # público
      dashboard/                       # cliente (protegido CUSTOMER)
      admin/                           # admin (protegido ADMIN)
      api/                             # route handlers
    components/                        # design system (ui/) + feature components
    lib/      (env, admin, firebase-web, money, idempotency, rate-limit, csrf, errors)
    auth/     (session, guards, rbac)
    server/   # dominio puro: schedule, scoring, delinquency, transitions, portfolio-math
    services/ # users, credit/*, risk/*, payments/*, portfolio/*, notifications/*, audit/*
    test/     # unit
  tests-integration/                   # contra Firestore real (proyecto credito-a1b4a)
  vitest.config.mts, next.config.ts, tsconfig.json, eslint.config.mjs
```

---

## 8. Modelo de datos (Firestore — colecciones)

NoSQL: sin FK ni restricciones a nivel de BD; las invariantes se aplican **por transacción y por
máquinas de estado en servicios**, con tests que prueban la condición de carrera. Firestore usa
Transactions y Batched Writes. Índices compuestos declarados en `firestore.indexes.json`.

Enums (tipos TS compartidos en `src/server/types.ts`): `Role`, `UserStatus`, `ApplicationStatus`,
`LoanStatus`, `PaymentStatus`, `DisbursementStatus`, `InstallmentStatus`, `DelinquencyStatus`,
`RiskLevel`, `NotificationStatus`, `AuditAction`, `TermFrequency`, `ActorType`.

### 8.1 Colecciones y forma de documento
- **`users/{uid}`** — `email, fullName, phone, role, status, createdAt, updatedAt`. (La contraseña NO
  vive aquí: está en Firebase Auth.)
- **`user_profiles/{uid}`** — `city?, occupation?, monthlyIncomeRange?, updatedAt`. Minimización: sin
  documento de identidad completo ni datos sensibles en MVP.
- **`loan_applications/{id}`** — `applicationNumber, userId, productId, requestedAmountPesos,
  termInstallments, termFrequency, status, decisionNotes?, reviewedBy?, reviewedAt?, createdAt,
  updatedAt`.
- **`credit_scores/{id}`** — `userId, applicationId?, score, riskLevel, modelVersion, calculatedAt,
  factors[]`.
  (Los factores se embeben como array de `{factorKey,label,weightBps,value,contributionBps,reason}` —
  1 documento por evaluación, evita suscripción 1:N innecesaria.)
- **`risk_rules/{key}`** — `name, kind, params(Map), version, isActive, effectiveFrom?, effectiveTo?, source`.
- **`credit_products/{code}`** — `name, currency:'COP', termInstallments, termFrequency,
  minTermInstallments, maxTermInstallments, effectiveFeeBps, isActive`.
- **`product_tiers/{productCode_position}`** — `productCode, position, amountPesos, minScore?, isActive`.
- **`user_limit_overrides/{id}`** — `userId, creditLimitPesos, overriddenBy, reason, active, createdAt`.
- **`loans/{id}`** — `loanNumber, applicationId, userId, productCode, principalPesos, interestPesos,
  feePesos, totalPayablePesos, pricing, status, delinquencyStatus?, daysPastDue?, outstandingPesos?, disbursedAt?,
  paidAt?, createdAt, updatedAt`. Caché de saldo/mora para filtros admin (actualizada por servicios,
  nunca por el cliente).
  - `pricing` es la **base de cálculo congelada** al crear el préstamo:
    `annualRateBps, effectiveFeeBps, rateVersion, termInstallments, termFrequency`. Obligatoria en los
    préstamos nuevos. Existe para que el recálculo de vencimientos al confirmar el desembolso use lo
    que el cliente aceptó y no la tasa vigente en ese momento (se la cambiaría). Los documentos
    anteriores a este campo no se recalculan: F9 debe detectar que falta el snapshot y no tocar el
    calendario.
- **`loan_installments/{loanId}_{n}`** — `loanId, installmentNumber, dueDate(Date), principalPesos,
  interestPesos, feePesos, totalPesos, paidPesos, status, paidAt?, paymentId?, pendingPaymentId?`.
  (Doc ID determinista `${loanId}_${n}` para ordenar y evitar duplicados.) `pendingPaymentId` es el pago
  `PENDING` que espera confirmación y hace de candado: se escribe en la misma transacción que crea el pago,
  así que dos registros simultáneos de la misma cuota se serializan y el segundo recibe 409 en lugar de dejar
  dos pagos que un admin tendría que depurar a mano. Lo libera el rechazo del pago (F10-2b).
- **`payments/{id}`** — `paymentNumber, userId, loanId, installmentId, amountPesos, currency,
  channel, reference?, adminNote?, status, receiptUrl?, idempotencyKey, createdAt/updatedAt,
  confirmedBy?, confirmedAt?, rejectedBy?, rejectedAt?, reason?`. `installmentId` es el doc ID
  determinista `${loanId}_{n}` de `loan_installments` y el builder lo valida contra `loanId`; un pago
  nace siempre `PENDING` y el schema rechaza `confirmedBy` sin `confirmedAt` (y `rejectedBy` sin
  `rejectedAt`). No hay `reversedBy`: la transición a `REVERSED` queda en `payment_events` con su actor.
  El doc ID es el propio `paymentNumber` (`PAY-{año}-{consecutivo de 4}`, leído dentro de la transacción
  que lo escribe, igual que `APP-{año}-{n}` en solicitudes): dos registros simultáneos chocan en la misma
  ruta y el perdedor reintenta con el número ya usado.
- **`payment_events/{paymentId}_{n}`** — `paymentId, fromStatus, toStatus, actorType, actorId?, reason?,
  metadata(Map), createdAt` (historial de la máquina de estados). Doc ID determinista: el historial se
  lee con `getAll` de ids construidos, sin índice compuesto (§8.2 no declara uno para esta colección).
- **`payment_channels/{id}`** — `name, type, instructionsText, meta(Map), isActive, createdAt, updatedAt`
  (instrucciones de transferencia/Nequi/QR/Bre-B **texto estático configurable**, sin APIs).
  `type` es un enum cerrado `BANK_TRANSFER|NEQUI|QR|BREB` y el doc ID es el propio tipo, así que
  `payments.channel` referencia un canal válido; los datos de la cuenta (banco, número, titular) van
  en `meta`, que es lo que edita un admin. `createdAt`/`updatedAt` se agregan por consistencia con las
  demás colecciones de configuración (§8.1 los omite en esta línea).
- **`disbursements/{loanId}`** — `loanId, provider:'manual', status, reference?, initiatedBy,
  confirmedBy?, confirmedAt?, initiatedAt, idempotencyKey, metadata(Map)`. Doc ID = `loanId`: un
  préstamo tiene un solo desembolso y un doble clic no puede crear dos. `metadata` guarda
  `rescheduledInstallments` al confirmar, para que un replay reconstruya la respuesta leyendo la
  entidad. `idempotencyKey` es la de la operación que **originó** el doc (el inicio); la de la
  confirmación no se guarda ahí para no pisarla.
- **`notifications/{id}`** — `userId, type, channel, title, body, status, readAt?, sentAt?, error?, payload(Map)`.
- **`interest_rates/{productType_version}`** — `productType, annualRateBps, maximumRateBps?,
  effectiveFrom, effectiveTo?, source, version, isActive`.
- **`audit_logs/{id}`** — `actorId?, actorRole?, action, entityType, entityId?, metadata(Map), ip?,
  userAgent?, createdAt`. **Append-only por Security Rules** (`update/delete: false`).
- **`system_config/{key}`** — `value(Map), updatedBy, updatedAt` (umbrales de mora, scoring, sesión).
- **`idempotency_keys/{sha256(scope|key)}`** — `scope, key, entityType, entityId, createdAt,
  expiresAt`. Doc ID determinista → crear de nuevo = conflicto (replay).

### 8.2 Índices compuestos necesarios (`firestore.indexes.json`)
- `loans`: `userId+status` (préstamos del usuario); `status+createdAt` (admin/cartera);
  `status+userId` cuando aplique.
- `payments`: `status+createdAt`; `userId+status`; `loanId+status`.
- `loan_applications`: `userId+status`; `status+createdAt`.
- `loan_installments`: `loanId+installmentNumber` (auto por doc ID).
- `audit_logs`: `createdAt`; `action+createdAt`; `actorId+createdAt`.
- `notifications`: `userId+status`; `userId+createdAt`.

---

## 9. Contratos API (resumen — detalle por endpoint con `api-and-interface-design` durante implementación)

Reglas globales: JSON; errores `{ "error": { "code", "message" } }`; Zod severo; autorización por rol en
servidor; `Idempotency-Key` obligatorio en operaciones de dinero; toda mutación se audita.

| Método y ruta | Rol | Idempotente | Audit |
|---|---|---|---|
| `POST /api/auth/register` | público | no | USER_CREATED |
| `POST /api/auth/session` (intercambia ID token → cookie) | público(auth) | no | — |
| `POST /api/auth/logout` | auth | no | — |
| `GET /api/me` | auth | — | — |
| `PATCH /api/me/profile` | CUSTOMER | no | — |
| `POST /api/loan-applications` | CUSTOMER | no | LOAN_REQUESTED |
| `GET /api/loan-applications` / `/:id` | CUSTOMER(owner)/ADMIN | — | — |
| `POST /api/loan-applications/:id/submit` | CUSTOMER(owner) | no | LOAN_REQUESTED |
| `GET /api/loans` / `/:id` | CUSTOMER(owner)/ADMIN | — | — |
| `GET /api/loans/:id/installments` | CUSTOMER(owner)/ADMIN | — | — |
| `POST /api/payments` | CUSTOMER(owner) | **sí** | PAYMENT_CREATED |
| `GET /api/payments/:id` | owner/ADMIN | — | — |
| `POST /api/payments/:id/receipt` | CUSTOMER(owner) | no | PAYMENT_RECEIPT_UPLOADED |
| `GET /api/payments/:id/receipt` (URL firmada, 5 min) | owner/ADMIN | — | — |
| `POST /api/admin/loan-applications/:id/approve` | ADMIN | no | LOAN_APPROVED / SCORE_CALCULATED |
| `POST /api/admin/loan-applications/:id/reject` | ADMIN | no | LOAN_REJECTED |
| `POST /api/admin/loans/:id/disburse/initiate` | ADMIN | **sí** | — |
| `POST /api/admin/loans/:id/disburse/confirm` | ADMIN | **sí** | LOAN_DISBURSED |
| `POST /api/admin/payments/:id/confirm` | ADMIN | **sí** | PAYMENT_CONFIRMED |
| `POST /api/admin/payments/:id/reject` | ADMIN | **sí** | PAYMENT_REJECTED |
| `POST /api/admin/payments/:id/reverse` | ADMIN | **sí** | PAYMENT_REVERSED |
| `GET /api/admin/portfolio` (métricas + filtros fecha/estado/riesgo/monto/mora) | ADMIN | — | — |
| `GET /api/admin/audit-logs` (solo lectura) | ADMIN | — | — |
| `GET/POST/PATCH /api/admin/config/**` | ADMIN | — | LIMIT_CHANGED, CONFIG_CHANGED |
| `GET/POST /api/admin/users` / `/_id/limit` | ADMIN | no | LIMIT_CHANGED |

> Los endpoints de ejemplo del productor se respetan; cada endpoint tendrá su contrato (request,
> response, validación, autorización, errores, idempotencia, auditoría) antes de implementarse.

---

## 10. Motor de scoring (explicable, por reglas)

- Interfaz `RiskEngine { calculate(ctx): Promise<ScoreResult> }`; `ScoreResult` con `score`,
  `riskLevel`, `factors[]`, `modelVersion`, `calculatedAt` → persistido en `credit_scores`.
- Factores (MVP), sin variables sensibles/discriminatorias: identidad verificada, ingresos
  verificables, capacidad de pago, historial de préstamos, historial de pagos, moras previas, número de
  solicitudes, deuda existente, relación cuota/ingreso.
- Pesos/umbrales configurables (`risk_rules`/`system_config`) con `version`. Score 0–100;
  `LOW ≥ 70`, `MEDIUM 45–69`, `HIGH < 45` (configurable).
- **Explicabilidad**: cada factor guarda `label`, `weight`, `value`, `contribution`, `reason` en
  lenguaje natural; UI "¿por qué este score?".
- Sustituible por ML sin tocar la arquitectura (mismo contrato, `model_version` por evaluación).

---

## 11. Pagos

- Flujo MVP **sin depender de Wompi/MercadoPago/Bre-B**: el cliente consulta su cuota → "Pagar" → ve
  monto e instrucciones (configuradas por admin en `payment_channels`: transferencia / QR / Nequi /
  Bre-B cuando corresponda, **solo texto e info estática**) → paga externamente → registra
  referencia/comprobante → **PENDING** → admin confirma → **CONFIRMED** → cuota actualizada → préstamo
  recalcula saldo.
- Estados de pago: `PENDING → CONFIRMED | REJECTED`; `CONFIRMED → REVERSED` (solo admin, auditable).
  **Un comprobante subido nunca paga una cuota**: la confirmación es humana.
- `payment_events` registra cada transición.
- Upload de comprobante a **Cloudinary** (entrega restringida): validación severa (extensión/MIME
  allowlist `png|jpg|jpeg|pdf`, ≤5 MB, nombre aleatorio; API secret solo en servidor), URL firmada con
  expiración solo owner/admin.
  - **Qué se guarda**: `payments.receiptUrl` es la ruta de entrega **sin firma**
    (`image/authenticated/microcredito/payments/{paymentNumber}/{uuid}.{format}`). Sin el componente
    `s--firma--` esa ruta no descarga nada, así que es inocua persistirla; la URL que sí entrega el
    archivo se firma bajo demanda en `GET /api/payments/:id/receipt` y caduca en 5 minutos.
  - **Cuándo se admite**: solo en un pago `PENDING` (el que sigue esperando decisión humana). El
    comprobante de un pago ya `CONFIRMED`/`REJECTED`/`REVERSED` **se conserva y se sigue viendo**
    (es la evidencia de una disputa), pero no se le adjunta uno nuevo. Un fallo al subir no altera
    el estado del pago: se reintenta. Reemplazar el comprobante de un pago `PENDING` borra el
    anterior del proveedor, y una subida que no llega a Firestore se borra también.
  - **Orden de operaciones**: validar (puro, sin red) → autorizar (lectura del pago) → subir →
    escribir en transacción. Autorizar **después** de subir permitiría que un cliente metiera
    archivos en el pago de otro.
  - **Sin credenciales, la app funciona**: `CLOUDINARY_*` vacías en `.env` significan "no
    configurado", y las rutas de comprobante responden 503 sin tumbar el resto de la app (§11 pide
    que el comprobante sea opcional, no que el almacenamiento sea obligatorio).
- **Idempotencia**: `Idempotency-Key` en creación/confirmación; documento `idempotency_keys` con ID =
  `sha256(scope|key)`; réplica devuelve resultado previo.
- **El importe lo decide el servidor**: `POST /api/payments` no tiene campo `amountPesos`. El pago vale el
  saldo de la cuota (`totalPesos - paidPesos`) leído dentro de la transacción, y el body es `strict`: un
  `amountPesos` manipulado es un 400, no un campo ignorado. Se puede registrar el pago de **cualquier**
  cuota pendiente del propio préstamo (la UI ofrece la próxima); la confirmación recalcula el saldo de esa
  cuota. No se acepta el pago de un préstamo `PENDING_DISBURSEMENT` (el dinero aún no salió), `PAID` ni
  `WRITTEN_OFF`; `DEFAULTED` sí lo admite, porque estar en mora no es estar saldado.
- Abstracción futura: `PaymentProvider`, `PaymentIntent`, `PaymentWebhook`, `PaymentReconciliation`
  (solo diseño; sin API bancaria inventada).

---

## 12. Desembolsos

- Préstamo aprobado → `PENDING_DISBURSEMENT`. Admin inicia → registra referencia → confirma →
  `DISBURSED`. Nunca automático sin confirmación válida.
- Implementación inicial: `ManualDisbursementProvider` bajo interfaz `DisbursementProvider`. La
  interfaz es honesta: describe transiciones de estado, no simula una llamada a un banco.
- Idempotente (doc `disbursements/{loanId}` + `idempotency_keys`).
- **La referencia es obligatoria antes de confirmar.** Se puede registrar al iniciar o en la
  confirmación; sin ella el confirm es un 409 y el préstamo sigue `PENDING_DISBURSEMENT`.
- **Al confirmar se re-programan los vencimientos** desde la fecha real de desembolso
  (`disbursedAt`), no desde la de aprobación: los vencimientos que nace con el préstamo son
  provisionales. El recálculo usa el snapshot `loans.pricing` y escribe **solo** `dueDate` en
  cada cuota; los importes quedan congelados y se revalidan contra los totales del préstamo antes
  de tocar nada. Si el préstamo no tiene snapshot (los anteriores a §8.1) el confirm es un 409
  explícito: requiere migración de datos, no un recálculo con la tasa vigente.
- **Pantalla admin por préstamo** (`/admin/prestamos`, `/admin/prestamos/{id}`): el detalle muestra
  titular, importe, condiciones y plan de pagos **antes** de transferir. El botón de iniciar queda
  deshabilitado y explica el motivo cuando falta el snapshot, para que el 409 no aparezca después
  de mover el dinero. Estados visibles: sin iniciar → `INITIATED` (referencia registrada, pendiente
  de confirmar) → `CONFIRMED` (quién, cuándo y con qué referencia; sin acciones). El navegador
  nunca decide el estado: las transiciones pasan por las APIs, con `Idempotency-Key` y `requireAdmin`.

---

## 13. Mora y cartera

- Estados de mora (derivados de cuotas + fechas, recalculados por servicio al confirmar pago y bajo
  demanda): `CURRENT`, `DUE_SOON`, `DUE_TODAY`, `OVERDUE`, `DEFAULT`, `PAID`.
- `days_past_due` por cuota = `máx(0, hoy - dueDate)`; a nivel préstamo = máximo entre cuotas impagas.
- Umbrales configurables (`system_config`): `dueSoonDays`, `overdueDays`, `defaultDays`. Sin intereses
  de mora arbitrarios.
- Caché en `loans` (delinquencyStatus/daysPastDue/outstandingPesos) para filtros admin, actualizada
  por servicios.
- Métricas de cartera (definiciones): cartera total (saldo por cobrar), vigente, vencida, en mora,
  desembolsado acumulado, recuperado acumulado, saldo pendiente, tasa de mora (vencido/total), tasa de
  recuperación (recuperado/desembolsado), préstamos activos/pagados/incumplidos, pérdida de cartera,
  rendimiento. Filtros: fecha, estado, riesgo, monto, mora.

---

## 14. Seguridad (resumen; detalle con `security-and-hardening` en FASE 17)

- **Auth**: credenciales gestionadas por Firebase Auth; sesión con cookie HTTP-only `SameSite=Lax`
  + `Secure` (prod), máx. 14 días; `verifySessionCookie(...,true)` por request; logout revoca.
- **Brute force**: protecciones nativas de Firebase Auth + rate limit propio en nuestra API
  (login/session: por IP + identificador; rutas sensibles por IP).
- **Autorización/RBAC** en backend por ruta; recursos resueltos por el uid de la **sesión** (jamás
  `user_id`/`loan_id`/`monto`/`estado`/`score` del cliente). Protección **IDOR** por scoping en
  servicios.
- **CSRF**: verificación de Origin en mutaciones + cookie `SameSite=Lax`.
- **Montos**: calculados en backend; el `amountPesos` que paga el cliente se deriva de la cuota esperada.
- **Uploads**: validación MIME/extensión/tamaño, bucket privado, URLs firmadas.
- **Errores**: mensajes seguros, sin stack/internos; Zod en el límite.
- **Idempotencia** en pagos/desembolsos/confirmaciones.
- **Firestore**: Security Rules niegan escritura directa del cliente en colecciones de negocio
  (muta solo la API vía Admin SDK); auditoría append-only.
- **Secrets**: `.env` gitignored, `lib/env.ts` (Zod), service account fuera de repo.

---

## 15. Auditoría

- `services/audit/` escribe `audit_logs` (append-only de facto y por Security Rules). No existe ruta de
  update/delete; la UI admin solo **lee**. Acciones: `USER_CREATED`, `LOAN_REQUESTED`, `LOAN_APPROVED`,
  `LOAN_REJECTED`, `LOAN_DISBURSEMENT_INITIATED`, `LOAN_DISBURSED`, `PAYMENT_CREATED`,
  `PAYMENT_CONFIRMED`, `PAYMENT_REJECTED`, `PAYMENT_REVERSED`, `PAYMENT_RECEIPT_UPLOADED`,
  `SCORE_CALCULATED`, `LIMIT_CHANGED`, `LOAN_STATUS_CHANGED`, `CONFIG_CHANGED`.
- Campos: actor, acción, entidad, id, timestamp, metadata, IP y user-agent (best-effort).

---

## 16. Notificaciones

- `NotificationService` con proveedores: MVP = in-app (bandeja en `notifications`) + `LogNotificationProvider`
  (dev) + `EmailNotificationProvider` (esqueleto activo solo si hay SMTP configurado; **sin
  credenciales reales**). WhatsApp/SMS/Push como proveedores futuros.
- Eventos: solicitud recibida/aprobada/rechazada, préstamo desembolsado, cuota próxima/vencida, pago
  confirmado/rechazado, préstamo pagado. Se disparan desde los servicios de dominio.

---

## 17. Pruebas y calidad

- **TDD** para: scoring, cálculo de cuotas, saldo, mora, transiciones de estado, autorización,
  idempotencia, pagos, desembolsos, APIs críticas.
- Unit (Vitest, `src/server/**`) + **integración contra Firestore/Auth emulador** (Firebase Emulator
  Suite) para servicios/APIs. Pruebas de condición de carrera (doble solicitud/préstamo activo).
- Browser: `browser-automation` (patchright local). Chrome DevTools MCP **no está configurado** → FASE
  18 usa el script disponible (decisión D7).
- "Terminar" exige: `lint` + `typecheck` + `test` + verificación manual/browser del slice.

---

## 18. Riesgos y mitigaciones

| Riesgo | Impacto | Mitigación |
|---|---|---|
| Next 16 cambia APIs | Alto | Leer docs oficiales en `node_modules/next/dist/docs/` ANTES de escribir (regla de AGENTS.md). |
| Next <16.3.6 vulnerable (RCE) | Crítico | Pin exacto a 16.3.6; `npm audit` en FASE 17. |
| NoSQL sin FK → invasiones de invariantes | Alto | Transacciones + máquinas de estado en servicios + tests de carrera (préstamo activo, idempotencia, confirmación). |
| Floats/doubles en dinero | Alto | Enteros con guard `Number.isSafeInteger`; utilería testada; nada de céntimos. |
| Firestore doubles para dinero en volúmenes altos | Bajo | Límite `2^53` documentado; guard desactivable solo con revisión + migración a valores string/decimal (anotado). |
| Confirmación de pago humana + idempotencia | Alto | Clave de idempotencia como ID de documento + transacción + tests de replay. |
| Regulación (usura, tasas) mal asumida | Alto | Nada legal en código; config + `PENDING_LEGAL_REVIEW`; revisión jurídica antes de operar. |
| Confundir "captura" con pago | Alto | Confirmación humana + auditoría; upload no marca cuota. |
| Emulador distinto de producción | Medio | Emulador oficial + reglas/índices versionados; smoke test en proyecto real de staging al cerrar FASE 16. |
| Rate limit en multi-instancia | Bajo | In-memory hoy (instancia única); migración a store compartido en despliegue real. |
| Service account / secrets expuestos | Alto | `.env` gitignored; Zod; nunca en cliente. |

---

## 19. Decisiones técnicas (aprobadas y pendientes)

| # | Decisión | Estado |
|---|---|---|
| D1 | Ubicación: carpeta nueva `microcredito/` | ✔ aprobada |
| D2 | Auth: **Firebase Auth** + session cookies (Admin SDK) | ✔ aprobada |
| D3 | BD: **Firebase Firestore** (NoSQL) + conexión directa real (sin emuladores) | ✔ aprobada |
| D4 | **Dinero en pesos enteros (COP)**, sin céntimos | ✔ aprobada |
| D5 | Comprobantes en **Cloudinary** (entrega restringida, URLs firmadas); sin Firebase Storage | ✔ aprobada |
| D6 | Notificaciones email: sin SMTP real en MVP (in-app + log + esqueleto) | ✔ aprobada |
| D7 | Tasa/tarifa demo 0 + `source=PENDING_LEGAL_REVIEW` | ✔ aprobada |
| D8 | Browser QA con `browser-automation` local (chrome-devtools MCP ausente) | ✔ aprobada |
| D9 | **Proyecto real para salir al mercado** (deploy/backups/reglas en FASE 16+; no bloquea MVP) | ✔ |
| D10 | Costo/infreaestructura: modo Spark/gratuito de Firebase para dev; plan de pago por uso al operar (anotado) | pendiente (solo plan) |

---

## 20. Criterios de éxito del MVP

1. Ciclo completo: registro → solicitud → scoring → aprobación → desembolso → "pago" (PENDING →
   CONFIRMED) → cuota pagada → saldo recalculado → métricas/auditoría actualizadas.
2. Ningún flujo marca una cuota pagada sin confirmación humana.
3. Replay de la misma operación (misma clave) no duplica nada.
4. Todo movimiento de dinero/estado tiene auditoría y notificación (donde aplique).
5. `lint`, `typecheck`, suite de tests verdes; verificación en navegador de los flujos principales.
6. Nada de dinero real, credenciales reales, ML o integraciones inventadas.
7. Reglas/índices de Firestore versionadas y desplegadas al proyecto real (`npm run deploy:rules`);
   credenciales de Cloudinary en `.env` (sin Storage de Firebase).

---

## 21. Regulación (pendientes, no verdades)

Producto orientado a mercado; el **MVP técnico** no autoriza por sí mismo actividad financiera. Antes
de operación comercial, asesoría jurídica colombiana sobre: actividad de crédito, tasas y **usura**
(fuente oficial a investigar al momento), protección al consumidor financiero, **habeas data** y
tratamiento de información financiera, protección de datos (Ley 1581/2012), cobranza, normas de
**captación**, financiación colaborativa, obligaciones tributarias y requisitos de operación como
empresa. El sistema expone estos parámetros como configuración, no como verdad legal.

---

## 22. Supuestos explícitos (corrígeme si fallo)

1. MVP en una sola instancia (rate limit en memoria aceptable).
2. COP sin céntimos → todos los importes son **pesos enteros**.
3. Tiers 50/75/100 son seed de arranque, reemplazable por admin.
4. Un pago cubre **exactamente el saldo restante de una cuota** (sin parciales ni multi-cuota) en MVP.
5. No hay notificación SMS/WhatsApp en MVP.
6. El score se calcula al presentar la solicitud; la versión guardada es la que decide.
7. El admin es humano; no hay auto-aprobación.
8. Dev/test sobre el **proyecto real** `credito-a1b4a` (service account vía `GOOGLE_APPLICATION_CREDENTIALS`).

---

## 23. Preguntas abiertas para aprobación

- ¿Confirmas los cambios v2 (Firebase, pesos enteros, producto real) para arrancar FASE 3?
- Para pruebas de integración y browsers se usará el **emulador local**; ¿tienes ya un proyecto
  Firebase (y permission de service account) para la fase de despliegue?, ¿o se queda 100% local en el
  MVP?
- ¿Algún ajuste a §6, §8, §9 o §22 antes de comenzar?