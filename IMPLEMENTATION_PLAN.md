# IMPLEMENTATION_PLAN — MVP Microcréditos (Colombia)

**Documento vivo.** v2 (2026-09-24): arquitectura **Firebase** + **pesos enteros** + producto real.
Se actualiza junto con PROJECT_SPEC.md. El checklist operativo vive al inicio de la ejecución en
`tasks/todo.md` (se crea en FASE 3). Filosofía: **slices verticales** que dejan el sistema funcionando,
testeado y verificado antes de seguir.

---

## 1. Objetivo del plan

Implementar el MVP §3.1 de PROJECT_SPEC.md en el orden F1–F19. Regla de oro: si una prueba falla →
**DETENER**, investigar, corregir la causa; no se desactiva el test, no se borran validaciones, no hay
hacks. Una tarea NO termina porque compila: exige `lint` + `typecheck` + tests + verificación.

## 2. Stack fijo (ver §7 del spec)

Next.js **16.3.6** (pin exacto — corrige GHSA-vcvr-r3jv-pc5j), React 19, TS strict, Tailwind v4,
**Firebase** (Firestore + Auth) conectado **directo al proyecto real `credito-a1b4a`**, **sin
emuladores** (decisión D3 del spec v3), comprobantes en **Cloudinary** (sin Firebase Storage, D5),
**firebase-admin 14.5.0**, Vitest 5, Zod, moneda en **pesos enteros (COP)**.

> Este documento se escribió para v2 (con Emulator Suite + Storage). Las decisiones D3/D5 del
> PROJECT_SPEC v3 reemplazan esa base: los comandos y verificaciones de abajo ya apuntan al
> proyecto real y la verificación es una lectura real, no `auth:export` del emulador.

## 3. Comandos estándar

```bash
npm run dev                 # Next dev
npm run build               # next build
npm run lint                # eslint
npm run typecheck           # tsc --noEmit
npm test                    # vitest run (unit, src/**)
npm run test:integration    # vitest run (tests-integration/**, contra el proyecto REAL)
npm run seed                # tsx scripts/seed.ts (admin de desarrollo, requiere .env)
npm run smoke               # smoke write+read+delete en Firestore real
npm run deploy:rules        # publica firestore.rules + índices con el service account
```

> Sin Docker ni Prisma: la "BD" es el Firestore del proyecto real. "Migraciones" = estructura de
> código (tipos/servicios) + `firestore.rules` + `firestore.indexes.json` versionados. Los tests de
> integración limpian lo que crean; no hay emuladores que resetear.

## 4. Definición de Done (cada tarea)

- [ ] `lint`, `typecheck`, tests pasan (unit y/o integración contra emulador)
- [ ] Cambio verificado en runtime (browser o llamada API real al emulador) cuando haya UI/API
- [ ] Ivariantes de dinero/estado cubiertos por test
- [ ] Auditoría + notificación donde aplique
- [ ] Sin secretos en repo; valores críticos configurables, no hardcodeados
- [ ] Docs/spec actualizados si cambió una decisión

---

## FASE 0 — Análisis del repositorio (HECHO)

`microcredito/` no existía; el repo `react` contiene proyectos independientes no reutilizables.
Se adoptan convenciones ya probadas en el repo (Next App Router + TS strict + Tailwind v4 + Vitest),
y la experiencia Firebase existente (montalchino/Dropshiping/TiendaG usan `firebase`/`firebase-admin`).
No se copia código. Salidas: este plan y PROJECT_SPEC.md.

## FASE 1 — Especificación (HECHO, v2 revisada)

`PROJECT_SPEC.md` actualizado con Firebase + pesos enteros + visión de producto real. Pendiente de
aprobación final del usuario.

## FASE 2 — Plan (HECHO — este documento, v2)

---

## FASE 3 — Foundation

### Tarea F3-1: Scaffold de la app, gitignore, lint y estructura — **HECHO**
- **Acceptance:** Next 16.3.6 (TS, Tailwind, App Router, `src/`) en `microcredito/`; `.env.example` /
  `.env` (solo valores dev del emulador); scripts `typecheck`, `test`, `test:integration` en
  `package.json`; `AGENTS.md` con regla de leer docs de Next en `node_modules/next/dist/docs/` + comandos.
- **Verify:** `npm run dev` responde; `lint` + `typecheck` pasan.
- **Files:** ~10. **Scope:** M.

### Tarea F3-2: Firebase init + Admin SDK (proyecto real, sin emuladores) — **HECHO**
- **Acceptance:** `firebase.json` (emuladores auth/firestore/storage, ports fijos, `--only`),
  `.firebaserc` (proyecto dev local demo), `firestore.rules` (borrador: cliente denegado salvo
  colecciones públicas/config), `firestore.indexes.json` (índices §8.2), `storage.rules` (bucket
  privado); `lib/admin.ts` inicializa Admin SDK (emulador: `process.env.FIRESTORE_EMULATOR_HOST` etc.);
  `lib/firebase-web.ts` para clientes. `npm run emulators` levanta; un script smoke escribe/lee en
  Firestore emulator.
- **Verify:** emulador arranca; smoke test escribe y lee; `firebase emulators:exec` en CI-local.
- **Files:** ~8. **Scope:** M. **Fuentes:** docs oficiales de Emulator Suite y Admin SDK 14.x.

### Tarea F3-3: Esqueleto de dominio + utilería money (pesos enteros) — **HECHO**
- **Acceptance:** `src/server/` con `money.ts` (add/sub/mul/div **enteros**, guard
  `Number.isSafeInteger`, format `es-CO` sin céntimos), `schedule.ts` (división de cuotas enteras con
  residuo en la última), `types.ts` (enums/estados compartidos). Tests: no pierde pesos, no acepta
  decimales, residuo correcto.
- **Verify:** `npm test` verde.
- **Files:** 4. **Scope:** S.

### Tarea F3-4: Idempotencia + rate limit + errors + env Zod — **HECHO**
- **Acceptance:** `lib/env.ts` (Zod) valida `.env`; `lib/idempotency.ts` (doc
  `idempotency_keys/{sha256(scope|key)}` + transacción; réplica devuelve resultado previo);
  `lib/rate-limit.ts` (ventana por IP ruta + identificador, in-memory, instancia única); `lib/errors.ts`
  (códigos JSON seguros). Tests: replay no re-ejecuta; 429 al exceder; clave distinta sí ejecuta.
- **Verify:** unit + integración contra emulador (colección `idempotency_keys`).
- **Files:** 6. **Scope:** M.

### Tarea F3-5: Design system base (frontend-ui-engineering) — **HECHO**
- **Acceptance:** tokens (color, tipografía, spacing), `ui/` primitivas (Button, Input, Card, Badge,
  Table, Stat, Modal, Toast), layout responsive mobile-first, foco visible, accesibilidad básica;
  landing placeholder en `/` mostrando el sistema.
- **Verify:** browser-automation: render + snapshot de accesibilidad.
- **Files:** ~12 → **F3-5a (tokens+primitivas)** y **F3-5b (componentes de datos)**.
- **Scope:** M/M.

### Checkpoint: Foundation
- [ ] app levanta y buildea; `lint`+`typecheck`+`test` verdes
- [ ] emulador Firebase operativo; smoke write/read OK; rules+indexes versionados
- [ ] revisión con humano antes de continuar

---

## FASE 4 — Identidad y usuarios (identity)

### Tarea F4-1: Colección users + seed de admin dev — **HECHO**
- **Acceptance:** `users/{uid}` y `user_profiles/{uid}` (forma de documento documentada en TS);
  `scripts/seed.ts` crea en el emulador usuario `admin@local.dev` (contraseña dev, marcada) vía
  Firebase Auth + doc `users` con role ADMIN.
- **Verify:** `npm run seed` en emulador; `firebase auth:export`/consola emulador muestra usuario.
- **Files:** ~3. **Scope:** M.

#### Cómo quedó implementada (2026-09-25)

- `src/server/user-doc.ts` — **dominio puro** (sin Next/Firebase): tipos `UserDoc` / `UserProfileDoc`
  (§8.1), schemas Zod **estrictos** (rechazan campos extra: la contraseña nunca entra al documento),
  factories `buildUserDoc` / `buildUserProfileDoc` (normalizan email, descartan cadenas vacías en vez
  de guardar `null`), guard `isAdminUser` (rol ADMIN **y** ACTIVE) y política
  `assertSeedPasswordIsStrong` (mínimo 12 caracteres).
- `src/services/users/seed-dev-admin.ts` — orquesta con `db`/`auth` **inyectados** (testeable; no
  importa `server-only`, que solo funciona bajo RSC). **Idempotente**: si el usuario de Auth ya
  existe reutiliza su uid y **no pisa** `users`/`user_profiles`; la contraseña sí se refresca para que
  el seed sea recuperable.
- `scripts/seed.ts` — inicializa el Admin SDK como `smoke`/`deploy` y llama al servicio. Lee
  `SEED_ADMIN_PASSWORD` de `.env` (**nunca en código ni en logs**) y falla rápido si falta o es corta.
- `.env.example` documenta `SEED_ADMIN_EMAIL/PASSWORD/FULL_NAME/PHONE`; el valor real vive en `.env`
  (gitignored) con una contraseña aleatoria generada.
- **Desviación del enunciado (por D3/D5 del spec v3):** no hay emuladores, así que el seed y su
  verificación corren contra el **proyecto real `credito-a1b4a`**. El verify es una lectura real de
  Auth + Firestore en lugar de `firebase auth:export`.
- **Verificado:** `npm run seed` dos veces → mismo uid y cero duplicados; lectura independiente
  confirma `users/{uid}` con `role=ADMIN, status=ACTIVE` y exactamente los campos del §8.1;
  `test:integration` cubre creación, idempotencia y rechazo de contraseña débil **sin tocar** Auth ni
  Firestore, y limpia lo que crea (el primer cleanup solo borraba Auth y dejó huérfanos: corregido).
- **Fuera de alcance aquí:** auditoría `USER_CREATED` (el servicio de auditoría es F14; el seed es
  herramienta de desarrollo, no una vía de negocio) y reglas de `users` (el catch-all ya las deniega
  al cliente; abrir permisos es F4-3).

### Tarea F4-2: Registro/login + exchange de sesión (cookies) — **HECHO**
- **Acceptance:** UI registro/login con Web SDK de Firebase Auth; `POST /api/auth/session` recibe el ID
  token y llama `createSessionCookie(idToken,{expiresIn})` → cookie HTTP-only SameSite=Lax; logout
  revoca refresh tokens y borra cookie; `verifySessionCookie(cookie,true)` por request. Rate limit en
  login/session. Tests de integración con emulador de auth: registro, login, sesión inválida/revocada,
  429.
- **Verify:** integración contra emulador + browser (registrar→login→cookie).
- **Files:** ~7. **Scope:** M. **Fuentes:** docs Firebase "Manage Session Cookies" (patrón oficial).

#### Cómo quedó implementada (2026-09-25)

- `src/lib/firebase-web.ts` — `parseFirebaseWebConfig` (Zod, lista **todas** las variables faltantes) y
  `getFirebaseWebAuth()`: `initializeAuth(getApps()[0] ?? initializeApp(config), { popupRedirectResolver,
  persistence: [browserLocalPersistence] })`, singleton en `globalThis` para sobrevivir al HMR. Los
  `NEXT_PUBLIC_*` se leen con **acceso literal** (`process.env.NEXT_PUBLIC_FIREBASE_API_KEY`), requisito
  de Next para inlinear; en servidor lanza (la UI es cliente).
- `src/server/auth-input.ts` — schemas Zod **estrictos**: `credentialsSchema`, `registrationSchema`
  (teléfono Colombian `+573…`), `sessionExchangeSchema`; `PASSWORD_MIN_LENGTH=8`; `authErrorMessage` mapea
  los códigos de Firebase a copy en español con **fallback genérico** (nunca filtra el código crudo).
- `src/server/auth-session.ts` — `SESSION_COOKIE_NAME="__session"`, `SESSION_MAX_AGE_MS=5 días` (dentro
  del máximo de 14 de Firebase, patrón del ejemplo oficial), `sessionCookieOptions` (`httpOnly`,
  `sameSite:"lax"`, `secure` solo en producción, `path:"/"`), `createSessionCookieForIdToken`,
  `verifySessionCookieForRequest` (**`checkRevoked: true`**, devuelve `null` ante cualquier error) y
  `revokeAllSessions`.
- `src/lib/origin.ts` — `isSameOrigin` compara **esquema + host + puerto**; `originCheckFrom` deriva el
  origen esperado de `Host` + `x-forwarded-proto` y **no confía en `x-forwarded-host`** (spoofeable);
  `assertSameOrigin` → 403 en las mutaciones. Se aplicó Origin en `/api/auth/session` y `/api/auth/logout`
  (el rate limit es solo por IP, no un control de CSRF).
- `src/services/auth/session-endpoint.ts` — `exchangeSession` / `readSession` / `closeSession` con
  `CookieStoreLike` y deps **inyectadas** (testeable sin Next): orden Origin → rate limit → body →
  cookie; `Retry-After` en el 429 y **cada intento cuenta**, incluso los rechazados.
- Rutas `src/app/api/auth/session/route.ts` (`POST` exchange + **`GET` verificación por request**) y
  `src/app/api/auth/logout/route.ts` (`POST`: `revokeAllSessions` + borrar cookie, idempotente).
- UI cliente: `src/components/auth/auth-form.tsx` (Web SDK `signInWithEmailAndPassword` /
  `createUserWithEmailAndPassword` → `getIdToken()` → `POST /api/auth/session`; **la contraseña nunca
  pasa por el servidor**), páginas `/login` y `/registro` (`src/app/(auth)/`), y
  `src/components/auth/session-bar.tsx` en el header del home (lee `GET /api/auth/session` al montar y
  ofrece "Cerrar sesión"). `LinkButton` + `buttonClassName` evitan el HTML inválido `a > button`.
- **Desviaciones (D3/D5 y entorno):** la app **no tenía Web app** en Firebase, así que se creó
  `microcredito-web` vía Management API y se completaron las `NEXT_PUBLIC_*` en `.env` (gitignored; los
  valores son configuración pública, no secretos). La integración corre contra el **proyecto real**, no
  un emulador, y crea/borrar usuarios con correos aleatorios.
- **Verificado:** `lint`, `typecheck`, 109 unit, **10 de integración** y `build` en verde. Browser
  (registrar→`/` con cookie `__session` httpOnly/Lax→`GET /api/auth/session` 200→logout con cookie
  borrada y 401→login de nuevo) con **0 errores de consola** y el usuario de QA borrado de Auth.
- **Hallazgo de entorno (no de código):** con el reloj local **~46 s atrasado** respecto a Firebase,
  `revokeRefreshTokens` no invalida la cookie durante esa ventana (`tokensValidAfterTime` se sella con
  el reloj local; el Admin SDK advierte que debe estar sincronizado). El test de integración espera al
  reloj local antes de afirmar la revocación y añade el caso determinista de **cuenta deshabilitada** →
  cookie rechazada; **no se modificó la hora del sistema**. En producción sincronizada no aplica (y el
  logout además borra la cookie).
- **Pendiente de decisión con el usuario:** `PASSWORD_MIN_LENGTH=8` (la spec no fija política de
  contraseña para usuarios finales), vigencia de 5 días vs 14, y el `GET /api/auth/session` (401 cuando
  no hay sesión; el navegador registra ese 401 en consola, no es un error de JS).
- **Fuera de alcance aquí:** reglas de lectura de `users`/`user_profiles` y guards/RBAC (F4-3).

### Tarea F4-3: Guards, RBAC y /api/me
- **Acceptance:** `auth/guards.ts`: `requireUser`, `requireRole('ADMIN')` (rol leído de `users/{uid}`
  en servidor); scoping por uid de sesión; `GET /api/me`, `PATCH /api/me/profile`. Tests: sin sesión→401,
  rol mal→403, IDOR (perfil ajeno→404/403).
- **Verify:** integración.
- **Files:** ~5. **Scope:** M.

### Checkpoint: Identidad
- [ ] registrar/login/logout de punta a punta (browser), brute force y RBAC probados
- [ ] revisión con humano

---

## FASE 5 — Solicitud de crédito (credit)

### Tarea F5-1: Colecciones credit + config
- **Acceptance:** `credit_products`, `product_tiers`, `user_limit_overrides`, `loan_applications`,
  `system_config` documentados en TS; seed de 3 tiers demo + producto; regla "un préstamo activo"
  preparada (invaronte por transacción, se enforce en FASE 8).
- **Verify:** seed + lectura.
- **Files:** ~4. **Scope:** M.

### Tarea F5-2: Servicio de solicitudes
- **Acceptance:** crear borrador, validar (tier elegible por historial, monto derivado en backend —
  `requestedAmountPesos` solo informativo en respuesta), submit → SUBMITTED, auditoría
  `LOAN_REQUESTED`. Tests: monto no coincide con tier, préstamo activo bloquea, doble submit.
- **Verify:** unit + integración.
- **Files:** ~4. **Scope:** M.

### Tarea F5-3: UI de solicitud y listado (cliente)
- **Acceptance:** "Solicitar préstamo" (monto del tier visible desde backend, término) y "Mis
  solicitudes"; errores desde backend; accesible/mobile-first.
- **Verify:** browser: presentar solicitud; 2ª solicitud bloqueada/restringida según estado.
- **Files:** ~6. **Scope:** M.

### Checkpoint: Solicitud — [ ] primera solicitud E2E; [ ] sin monto arbitrario ni 2ª con préstamo activo

---

## FASE 6 — Scoring (risk)

### Tarea F6-1: Motor de reglas (dominio puro)
- **Acceptance:** `RiskEngine` + `RuleBasedRiskEngine` (score 0–100, `riskLevel`, factores con
  `label/weight/value/contribution/reason`, `modelVersion`, sin variables discriminatorias); reglas
  configurables. Tests de cada factor y bordes (0/100, umbrales LOW/MEDIUM/HIGH).
- **Verify:** `npm test`.
- **Files:** ~4. **Scope:** M.

### Tarea F6-2: Persistencia del score + servicio
- **Acceptance:** `credit_scores` (factores embebidos) + `risk_rules`; servicio calcula al presentar
  solicitud; auditoría `SCORE_CALCULATED`; lectura para admin.
- **Verify:** integración: score guardado y revisable.
- **Files:** ~4. **Scope:** M.

### Tarea F6-3: Explicabilidad en UI (admin + cliente)
- **Acceptance:** panel "¿Por qué este score?" con factores/contribución; visible a admin y al cliente
  si el producto lo permite (config).
- **Verify:** browser snapshot.
- **Files:** ~4. **Scope:** S.

### Checkpoint: Scoring — [ ] score reproducible/explicable; bordes verdes

---

## FASE 7 — Aprobación (credit)

### Tarea F7-1: Servicio de aprobación/rechazo
- **Acceptance:** transiciones SOLO desde `SUBMITTED/UNDER_REVIEW` (máquina de estados testada), roles
  ADMIN, score requerido al aprobar, auditoría + notificación, motivo en rechazo. Tests: transición
  inválida, solicitud ajena.
- **Verify:** unit + integración.
- **Files:** ~3. **Scope:** M.

### Tarea F7-2: UI admin de solicitudes y detalle
- **Acceptance:** lista admin (filtro estado), detalle con perfil+score desglosado+acciones; confirmación
  en approve; errores claros.
- **Verify:** browser.
- **Files:** ~6. **Scope:** M.

### Checkpoint: Aprobación — [ ] admin aprueba/rechaza; UI+auditoría+historial OK

---

## FASE 8 — Préstamo y cuotas (credit)

> **Deuda técnica CERRADA (acordado en F7-1, resuelto antes de F9-1):**
> - `withIdempotency` (`src/lib/idempotency.ts`) ahora escribe la forma de PROJECT_SPEC §8.1:
>   `scope, key, entityType, entityId, createdAt, expiresAt`. Se eliminó `result`: un replay NO
>   ejecuta `run` y el llamador **reconstruye la respuesta leyendo la entidad**
>   (`readDecisionPayload` en `approval-service.ts`). F9-1 (desembolso) y F10-2 (pagos) deben
>   seguir ese mismo patrón: el guard solo garantiza ejecución única, la respuesta se relee.

### Tarea F8-1: Colecciones Loan/Installment + invariante activo - **HECHO**
- **Acceptance:** `loans` (con caché deuda/mora) y `loan_installments/{loanId}_{n}`; **invaronte "un
  préstamo activo" enforced por transacción** (leer préstamos activos del user antes de crear) + test
  de condición de carrera (dos creates concurrentes → solo uno pasa).
- **Verify:** integración: intento de 2º activo falla. **Verificado:** 53/53 integración, 274/274
  unitarios, typecheck limpio, 0 residuos en el proyecto real. El test de carrera se validó
  **quitando** el invariante: sin él pasan los 2 creates (test con dientes, no vacuous).
- **Files:** ~3. **Scope:** M.

### Tarea F8-2: Generación de cuotas (dominio) + creación del préstamo - **HECHO**
- **Acceptance:** `schedule.ts` en pesos enteros con tests; servicio `createLoanFromApprovedApplication`
  (requiere APPROVED, genera cuotas con `dueDate` por frecuencia, suma exacta, actualiza caché),
  auditoría `LOAN_STATUS_CHANGED`.
- **Decisiones tomadas por el usuario (2026-09-26):**
  - **Amortización francesa** (saldo decreciente), no prorrateo plano. La cuota nivel se
    resuelve con la fórmula de anidad en `BigInt` para que sea exacta y el redondeo a pesos
    sea una sola decisión auditable. El capital de las cuotas es creciente; la última
    absorbs el saldo restante.
  - `disbursementDate` **opcional** al crear el préstamo: el calendario nace tentativo y
    **F9** lo recalcula con la fecha real del desembolso. Los importes NO dependen de esa
    fecha (propiedad verificada por test), así que recalcular solo mueve vencimientos.
  - El 500 de `?estado=APPROVED` se resuelve con IAM, notouchando la query: falta
    `roles/datastore.owner` para desplegar el índice `[status, createdAt]`.
- **Verify:** unit + integración. **Verificado:** 315/315 unitarios, 59/59 integración,
  typecheck limpio, lint 0 errores, 0 residuos.
- **Files:** ~4. **Scope:** M.

### Tarea F8-3: Layout cliente y detalle del préstamo [x] HECHO
- **Acceptance:** "Mis préstamos" y detalle (estado, saldo, próximo vencimiento) + calendario de cuotas;
  datos desde backend; accesible.
- **Implementación:** lecturas en `loan-service.ts` (`listLoansForUser`, `getLoanForUser`,
  `listInstallmentsForLoan`, `findNextInstallment`, `summarizeLoan`); API `GET /api/loans` y
  `GET /api/loans/[id]`; páginas `(dashboard)/mis-prestamos` y `/mis-prestamos/[id]`;
  `loans-list.tsx` y `loan-detail.tsx`; nav con "Mis préstamos".
- **Decisiones:** el cliente nunca escribe Firestore (todo por API con la cookie de sesión);
  `listLoansForUser` filtra por `userId` y ordena en memoria para NO pedir el índice
  compuesto `[userId, createdAt]` (aún no desplegado); `nextDueAt`/`nextInstallmentId` se
  derivan de la primera cuota PENDING en vez de persistirse (así se mueven solos al
  recalcular en F9); 404/403 por ownership igual que en solicitudes.
- **Accesibilidad verificada en browser:** `caption` en la tabla, `scope="col"` en las 7
  cabeceras, `<time dateTime>`, `role="status"` en carga y `role="alert"` en error, texto
  "próxima a vencer" solo para lectores de pantalla, estado siempre con texto (nunca solo
  color).
- **Dos bugs encontrados mirando el render, no los tests:**
  1. Las fechas de vencimiento se formateaban en hora local y el navegador (UTC-5) mostraba
     un día antes del contractual. Ahora `formatDueDate` formatea en UTC con
     `Intl.formatToParts` (date-fns v4 no acepta `timeZone`). Fijado con tests.
  2. Un préstamo en `PENDING_DISBURSEMENT` marcaba sus cuotas como "Vencida" aunque el
     calendario es provisional (decisión F9). Ahora solo se marca con el préstamo
     desembolsado.
- **Verify:** browser. **Verificado:** login real con usuario de prueba, lista y detalle
  renderizados con datos de Firestore, `/api/loans/{id}` inexistente -> 404, importes
  cuadrados en pantalla (capital 50.000 exacto, total 53.656), fixture y usuario de Auth
  borrados. 334/334 unitarios, 64/64 integración, typecheck limpio, lint 0 errores,
  0 residuos.
- **Files:** ~7. **Scope:** M.

### Checkpoint: Préstamo/cuotas — [x] cuotas exactas; 2º activo bloqueado (race test verde); "Mis préstamos" con calendario

---

## FASE 9 — Desembolso manual (credit)

### Tarea F9-1: Disbursements + ManualDisbursementProvider
- **Acceptance:** `disbursements/{loanId}` bajo `DisbursementProvider` (impl. `Manual`); initiate/confirm:
  PENDING_DISBURSEMENT → DISBURSED solo con referencia + confirmación humana; idempotente; auditoría
  `LOAN_DISBURSED`; nunca automático. Tests de flujo e idempotencia.
- **Verify:** unit + integración (replayen no duplica).
- **Files:** ~4. **Scope:** M.
- **Decisiones:**
  - La referencia es obligatoria **antes** de confirmar; se acepta al iniciar o en el confirm (409
    si falta). El doc ID es `loanId`, así que un doble clic no crea dos desembolsos.
  - Al confirmar se re-programan los vencimientos desde `disbursedAt` (los provisionales nacen
    desde la aprobación) usando el snapshot `loans.pricing`, y se escribe **solo** `dueDate`. Los
    importes se revalidan contra los totales del préstamo antes de tocar nada; sin snapshot el
    confirm es 409 (exige migración, no recalcular con la tasa vigente).
  - Las cuotas se leen por id determinista con un `getAll`: sin query, sin índice compuesto nuevo
    (hoy no se pueden desplegar por IAM).
  - `metadata.rescheduledInstallments` en el doc hace que un replay reconstruya la respuesta
    leyendo la entidad, igual que el resto del sistema.
  - Se añade `LOAN_DISBURSEMENT_INITIATED` al enum de auditoría: el inicio es un evento
    accountable por separado ("inició A, confirmó B").
- **Verificado:** 21 unit del servicio + 16 del dominio + 7 de integración contra Firestore real
  (flujo completo, replay de initiate y confirm, sin referencia, tasa v2 no altera el snapshot,
  préstamo legacy sin pricing, CUSTOMER 403). 384/384 unit, 75/75 integración, typecheck limpio,
  lint 0 errores (15 warnings preexistentes), 0 residuos de test.

### Tarea F9-2: UI admin de desembolso
- **Acceptance:** pantalla por préstamo: iniciar (referencia) → confirmar; estados visibles; solo ADMIN.
- **Verify:** browser.
- **Files:** ~4. **Scope:** S.
- **Decisiones:**
  - `/admin/prestamos` (lista con filtro por estado) + `/admin/prestamos/[id]` (detalle operativo). Se
    leen **directamente** en el server component, sin endpoints de lectura nuevos: las lecturas admin
    no cruzan el navegador y así no hay superficie HTTP que auditar.
  - Lecturas admin en `admin-loan-service.ts`, **separadas** de `listLoansForUser`/`getLoanForUser`
    (F8-3): esas aplican `assertOwnedBy` porque son del cliente; mezclarlas haría fácil saltarse la
    autorización en un refactor.
  - Con filtro de estado la query es de igualdad de un solo campo (índice automático) y el orden se
    resuelve **en memoria**: un `orderBy` cruzado pediría `[status, createdAt]`, que no se puede
    desplegar por IAM. Sin filtro, `orderBy createdAt` (índice simple) + tope de 50.
  - La pantalla muestra titular, importe, condiciones y plan de pagos **antes** de transferir, y
    avisa del caso legacy sin `pricing` (botón deshabilitado + explicación) en vez de dejar que el
    admin descubra el 409 después de transferir.
  - `DisbursementActions` es el patrón de `ApplicationDecisionActions`: clave de idempotencia
    generada al abrir el diálogo y **reutilizada** en los reintentos; el botón queda deshabilitado
    mientras corre la petición.
- **Verificado:** 8 unit del servicio de lectura + 7 de integración contra Firestore real (cola de
  pendientes ordenada, detalle con cuotas/titular/desembolso, desembolso confirmado, legacy sin
  pricing, esqueleto sin importes, 404). **Recorrido visual hecho con sesión ADMIN real** sobre un
  fixture: los cuatro estados (sin iniciar → iniciado → confirmado, más el esqueleto sin datos) se
  ven bien, con esperas reales y sin requests fallidas; todas las rutas admin devuelven 200.
  400/400 unit, 82/82 integración, typecheck limpio, lint 0 errores (15 warnings), 0 residuos.
- **Dos 500 que solo aparecieron al usar la app** (ninguno lo cazaron los tests):
  1. `listApplicationsForAdmin` (F7-2) hacía `where(status) + orderBy(createdAt)` → `FAILED_
     PRECONDITION: The query requires an index`. Corregido a igualdad pura + orden en memoria, con
     un test que falla si alguien recombina `where` con `orderBy`.
  2. `formatPesos` se evaluaba al construir el `<Modal>` **cerrado** en `DisbursementActions` →
     `RangeError: Valor no es entero seguro: undefined` en el detalle de un préstamo esqueleto. El
     componente ahora usa `formatPesosOrDash` y acepta `principalPesos?: number`.
- **Fuga de test encontrada al limpiar:** `loan-application.test.ts` sembraba un préstamo con `.add()`
  (id automático) y su `afterAll` no lo borraba: 43 documentos huérfanos acumulados en el proyecto
  real. Corregido, y `check-test-leftovers` ahora detecta préstamos sin `loanNumber` o con `userId`
  inexistente.


### Checkpoint: Desembolso — [x] desembolso manual responsable; replay no duplica
> Cerrado con código **y** recorrido visual verificado (ver "Verificado" en F9-2). El paso de dinero
> no depende de la UI: las dos APIs son la vía real y están cubiertas por integración.

---

## FASE 10 — Pagos (payments)

### Tarea F10-1: Colecciones payments + canales - **HECHO**
- **Acceptance:** `payments`, `payment_events`, `payment_channels` (instrucciones estáticas demo:
  transferencia/Nequi/QR/Bre-B **texto configurable**); seed.
- **Verify:** seed + lectura. **Verificado:** 432/432 unitarios, 87/87 integración (12 archivos),
  typecheck limpio, lint 0 errores, 0 residuos en el proyecto real; `npm run seed` dos veces =
  4 canales y luego 0. `payment_events` con doc ID determinista `${paymentId}_${n}` (historial sin
  índice compuesto) y enum de canal `BANK_TRANSFER|NEQUI|QR|BREB` con el ID = tipo. Ver WORKLOG.
- **Files:** ~4. **Scope:** M.

### Tarea F10-2: Servicio de pagos (crear/confirmar/rechazar/reversar) — **F10-2a HECHO**, falta F10-2b
- **Acceptance:** dominio `server/payments.ts` (máquina PENDING→CONFIRMED/REJECTED; CONFIRMED→REVERSED)
  + servicio: crear (owner, monto = saldo de cuota desde backend, referencia opcional, idempotente,
  `PAYMENT_CREATED`); confirmar (ADMIN, idempotente, actualiza cuota → PAID, recalcula saldo, `PAYMENT_CONFIRMED`);
  rechazar (motivo); reversar (auditable, revierte si aplica). **Un upload jamás paga.**
  Tests: doble POST misma key, monto manipulado desestimado, pago ajeno, reversar, saldo correcto.
- **F10-2a (hecho):** `server/payments.ts` (saldo, `PAY-{año}-{n}`, asserts de préstamo/cuota) +
  `payment-service` (`createPayment`, `getPaymentForUser`, `getPaymentForAdmin`) + `POST /api/payments`
  (sin `amountPesos`, `strict`, rate limit 20/h) + `GET /api/payments/:id` (owner/ADMIN). Candado
  `loan_installments.pendingPaymentId`: dos registros simultáneos de la misma cuota → uno gana y el
  otro 409. `withIdempotency` acepta que `run` devuelva el `entityId` (el doc ID es el número) y el
  replay devuelve el guardado. **Verificado:** 470/470 unitarios, 95/95 integración (13 archivos),
  typecheck limpio, lint 0 errores, 0 residuos. Ver WORKLOG.
- **Pendiente F10-2b:** máquina de estados en `server/payments.ts`, confirmar/rechazar/reversar con
  recálculo de cuota y préstamo, y **limpiar `pendingPaymentId` al rechazar** (si no, la cuota queda
  bloqueada para siempre).
- **Files:** ~6 → **F10-2a** (crear+idempotencia) y **F10-2b** (confirmar/rechazar/reversar+recálculo).
- **Scope:** M/M.

### Tarea F10-3: Upload validado de comprobante (Storage privado)
- **Acceptance:** `POST /api/payments/:id/receipt`: MIME/extensión allowlist, ≤5 MB, nombre aleatorio,
  Storage privado, URL firmada owner/admin; fallo no altera estado del pago.
- **Verify:** integración (formato malo→400, acceso ajeno→403).
- **Files:** ~4. **Scope:** M.
- **HECHO:** sin Firebase Storage, los comprobantes van a **Cloudinary** con entrega restringida
  (`authenticated`) + URL firmada corta (5 min) servida por `GET /api/payments/:id/receipt`. La
  escritura es en dos fases: el pago queda `PENDING_RECEIPT` y solo pasa a `PENDING` si el asset
  existe; un fallo de Cloudinary no deja el pago a medio hacer. Ver WORKLOG (F10-1/F10-3).

### Tarea F10-4: UI cliente de pago + UI admin de pagos
- **Acceptance:** cliente: "Pagar cuota" → monto+instrucciones+referencia/comprobante → PENDING; histórico.
  Admin: cola PENDING → confirmar/rechazar/reversar con motivo.
- **Verify:** browser E2E (crear→confirmar→cuota PAID).
- **Files:** ~8 → **F10-4a** cliente, **F10-4b** admin. **Scope:** M/M.
- **HECHO Y VERIFICADO en browser:** registrar → "Pago en revisión"; admin rechaza con motivo → la cuota
  vuelve a estar pagable; se reintenta y la UI se actualiza sola; admin confirma → cuota `Pagada`, saldo
  y "cuotas pagadas" al día. Dos bugs reales salieron en esa prueba y están corregidos: el `Modal` sin
  `max-height` dejaba el botón de envío fuera de la pantalla, y el detalle del préstamo se leía en el
  cliente, donde `router.refresh()` no lo actualizaba. Ver WORKLOG (F10-3/F10-4).

### Checkpoint: Pagos — [x] upload no paga; solo confirm humana; E2E completo; sin duplicados

---

## FASE 11 — Mora (portfolio)

### Tarea F11-1: Motor de mora (dominio)
- **Acceptance:** `server/delinquency.ts`: `daysPastDue` y estados `CURRENT|DUE_SOON|DUE_TODAY|
  OVERDUE|DEFAULT|PAID` con umbrales de `system_config`; `recalcLoanDelinquency` actualiza caché en
  `loans`; tests de bordes (hoy=vencimiento, +1 día, umbral default, cuota pagada).
- **Verify:** `npm test`.
- **Files:** 3. **Scope:** M.
- **HECHO Y VERIFICADO:** dominio puro en `src/server/delinquency.ts` (límites de día exactos,
  cuota con overpay = dato corrupto que falla en voz alta, umbrales de `system_config/delinquency`
  validados) + servicio de cartera en `src/services/credit/delinquency-service.ts` (lectura en
  fresco sin escribir + recálculo bajo demanda que sí escribe, con auditoría y avisos) +
  `src/server/loan-recalc.ts` (patch de caché compartido con F10-2b). Ver WORKLOG (F11).

### Tarea F11-2: Recálculo integrado + UI de mora (admin)
- **Acceptance:** recálculo tras confirmar pago y bajo demanda; pantalla "Mora" con filtros y
  `days_past_due`; notificación de cuota próxima/vencida.
- **Verify:** integración + browser.
- **Files:** ~5. **Scope:** M.
- **HECHO Y VERIFICADO EN BROWSER:** `/admin/mora` recalcula al vuelo (sin escribir al abrir) y
  muestra la caché vieja al lado para ver la diferencia; filtros por estado sobre el recálculo;
  "Recalcular cartera" y botón por fila (`POST /api/admin/delinquency/recalc`, idempotente por
  naturaleza, rate limit 10/10 min); avisos `INSTALLMENT_DUE_SOON`/`INSTALLMENT_OVERDUE` con doc ID
  determinista (no duplican al repetir). Ver WORKLOG (F11).

### Checkpoint: Mora — [x] estados/días correctos; notificaciones disparadas

---

## FASE 12 — Dashboard cliente (ui)
- **Título:** inicio con estado financiero (préstamo/saldo/siguiente cuota), accesos a solicitar/ver/
  pagar/historial/notificaciones; consistente con el design system; estados vacíos.
- **Verify:** browser + snapshot accesibilidad. **Files:** ~6. **Scope:** M.
- **HECHO Y VERIFICADO EN BROWSER:** `/` para clientes es el dashboard: saludo con `fullName`,
  `ActiveLoanCard` (modos `no_loans` / `no_active` / `active` con saldo, próxima cuota con días al
  vencimiento en UTC, progreso de cuotas accesible), accesos rápidos ("Registrar pago" solo con
  préstamo desembolsado) y últimos 3 avisos + bandeja `/mis-notificaciones` (SOLO lectura; leído/
  proveedores de envío quedan para F15-1). Nav de cliente + "Notificaciones" y estado activo
  (`aria-current`) con NavLinks. Dominio puro `server/client-dashboard.ts` (unión discriminada por
  `mode`, probado: 11 tests) y servicio SOLO lectura `client-dashboard-service.ts` (índices simples,
  avisos ordenados en memoria).
- **QA encontró y corrigió un bug preexistente:** `GET /api/credit-products` devolvía 500 en el
  proyecto real (consulta `product_tiers` con `orderBy("position")` exige el índice compuesto
  `[isActive, productCode, position]`, nunca desplegado por falta de `roles/datastore.owner`). Se
  cambió la consulta a igualdades simples + orden en memoria (convención del proyecto, igual que
  `loan-application-service`) y se quitó el índice de `firestore.indexes.json`. Ver WORKLOG (F12).

### Ajuste previo a F13 — Regla de plazo (pagos mensuales, mínimo 2 cuotas, plazo elegible)
- **HECHO:** frecuencia **única por producto** (MICRO_BÁSICO = `MONTHLY`) y rango
  `minTermInstallments`/`maxTermInstallments` (mín. 2). El cliente elige cuántas cuotas (2–6).
- Dominio: `CreditProductDoc` + campos con zod (`max>=min`, `min>=2`, `termInstallments` en rango) y
  `validateApplicationTerm` (frecuencia = del producto y `n` en rango) aplicado en draft y servicio.
- Seed: producto mensual 2–6 + **upgrade aditivo** de docs legados sin rango.
- Cotización: `GET /api/credit-products/quote` con `resolvePricing` + `buildLoanSchedule` (la misma
  fuente de la creación) para un preview exacto de pesos.
- UI: selector de cuotas en cards radio + panel preview (`aria-live`) en `loan-application-form.tsx`.
- Verificación: **637/637 unitarios**, typecheck/lint/build limpios. Ver WORKLOG (Regla de plazo).

---

## FASE 13 — Dashboard admin (ui + portfolio)

### Tarea F13-1: Métricas de cartera (dominio + servicio)
- **Acceptance:** `server/portfolio-math.ts` con las 14 métricas §13 del spec y definiciones testadas;
  servicio de agregación con filtros (fecha, estado, riesgo, monto, mora) usando la caché en `loans`.
- **Verify:** unit + integración sobre dataset de seed (activo/vencido/pagado/incumplido).
- **Files:** ~4. **Scope:** M.
- **HECHO:**
  - `server/portfolio-math.ts`: 14 métricas (cartera total, vigente, vencida, en mora, desembolsado
    acumulado, recuperado acumulado, saldo pendiente, tasa mora, tasa recuperación, activos/pagados/
    incumplidos, pérdida de cartera, rendimiento) + particiones auxiliares. Definiciones fijadas por
    test: `recuperado = Σ máx(0, totalPayable − outstanding)` (espejo `saldoPendiente`, identidad
    `recuperado + saldoPendiente = Σ totalPayable`), `perdida = outstanding de WRITTEN_OFF`,
    `vigente + vencida = cartera`, ratios en bps con `roundDiv`.
  - `portfolio-service.ts`: lectura de la caché de `loans` con 5 igualdades por `status` (sin índices
    compuestos) + join de riesgo en `credit_scores/{applicationId}` (`getAll`), filtros
    fecha/estado/riesgo/monto/mora, `skippedLegacy` para docs pre-esquema y `truncated` sobre el tope.
  - Verificados **665/665 unitarios** (+23), typecheck/lint/build limpios. Ver WORKLOG (F13-1).

### Tarea F13-2: Dashboard admin + gestión
- **Acceptance:** dashboard (stats clave), usuarios, configuración (productos/tiers/tasas/umbrales/
  canales), ajuste de límite por usuario (`LIMIT_CHANGED` auditado); solo ADMIN.
- **Verify:** browser + integración de autorización.
- **Files:** ~8 → **F13-2a** dashboard+usuarios, **F13-2b** configuración. **Scope:** M/M.
- **F13-2a HECHO** (dashboard + usuarios + límite por usuario):
  - `server/loan-application.ts`: `capTierByCreditLimit` (puro) + `findEligibleTier(..., creditLimitPesos?)`.
    El límite baja el tier al mayor monto que cabe; si no alcanza el mínimo del producto,
    `canApply: false` con motivo. El cap se aplica **después** de la reducción por incumplimiento.
  - `services/users/user-limit-service.ts`: `listUsersWithLimits` (usuarios + override activo, un
    `getAll`), `readActiveCreditLimit`, `setUserCreditLimit` y `clearUserCreditLimit`. Doc único
    `{uid}` (idempotente por naturaleza) + auditoría `LIMIT_CHANGED` en cada cambio.
  - `createLoanApplication` lee el override (`readActiveCreditLimit`) antes de resolver el tier.
  - Rutas: `GET /api/admin/users` y `POST /api/admin/users/[uid]/limit` (requireAdmin +
    assertSameOrigin + rate limit; sin `Idempotency-Key` por ser idempotente por clave `{uid}`).
  - UI: `/admin` es el panel (métricas §13 desde la caché, bps→%, avisos de `truncated`/`skippedLegacy`,
    atajos) y `/admin/usuarios` lista clientes con formulario de límite (`UserLimitForm`, cliente).
    Nav admin: "Panel" y "Usuarios".
  - Verificados **687/687 unitarios** (+22), typecheck/lint/build limpios (15 warnings
    preexistentes). Browser/integración pendientes. Ver WORKLOG (F13-2a).
- **F13-2b HECHO** (configuración: productos/tiers/tasas/umbrales/canales con `CONFIG_CHANGED`):
  - `server/admin-config.ts` (nuevo): invariantes entre documentos — montos de tiers activos que
    crecen con `position`, producto activo exige ≥1 tier activo y ≥1 tasa activa, tasas append-only,
    umbrales `dueSoonDays < overdueDays` (coherente con el parser del motor), y `diff` de auditoría.
    `parseEffectiveFrom` valida calendario con round-trip, y los IDs validan código no vacío.
  - `services/admin/admin-config-service.ts` (nuevo): `listAdminConfig` + 8 mutaciones. Todas en una
    transacción con `audit_logs` (`AuditAction.CONFIG_CHANGED`, `metadata:{reason,changes}`), rechazo
    de no-ops, preservación de `createdAt` y `Idempotency-Key` en las altas de tier y tasa.
  - Rutas: `GET /api/admin/config` (solo lectura, sin rate limit) y 7 escrituras bajo
    `src/app/api/admin/config/**`, con `requireAdmin` + `assertSameOrigin` + rate limit (30/h por
    admin) + Zod + `reason` obligatorio, con el ceremonial compartido en `src/lib/admin-config-request.ts`.
  - UI: `/admin/configuracion` (server component) con cinco tarjetas y seis componentes cliente que
    comparten `useConfigSave`; nav admin suma "Configuración".
  - Verificados **772/772 unitarios** (+85: 34 dominio, 39 servicio, 12 helper), typecheck/lint/build
    limpios (15 warnings preexistentes) y **browser contra el proyecto real**: lectura con datos
    reales, guard de sesión, validación de motivo en cliente, y `PATCH` sin cambios → 400 "el cambio
    no modifica ningún valor" mostrado en pantalla sin escribir. Ver WORKLOG (F13-2b).
- **F13-3 HECHO** (rediseño del admin: shell, navegación, panel y configuración por pestañas):
  - `app/admin/layout.tsx`: encabezado slim (identidad + notificaciones + sesión) y rail lateral;
    los ocho enlaces de sección salen del header, la campana se queda.
  - `services/admin/admin-pending-service.ts` (nuevo): qué espera decisión humana. Igualdad de un
    solo campo por cola (índice automático), tope de 200 y `truncated` explícito; la lectura falla
    sin tumbar el admin.
  - `services/admin/application-funnel-service.ts` (nuevo): embudo de `loan_applications` por estado.
    Nace de un diagnóstico, no de una suposición: el panel leía solo `loans` y el proyecto real
    tiene 0 préstamos y 495 solicitudes, así que mostraba catorce ceros.
  - `app/admin/page.tsx`: cola primero, embudo después, cartera al final con estado vacío honesto;
    tokens `warning` reales (los `warn-*` no existen en el tema) y aviso de `truncated`.
  - `components/ui/tabs.tsx` (nuevo) + `components/admin/config-workspace.tsx`: `/admin/configuracion`
    en cinco pestañas (Producto · Montos · Tasa · Mora · Canales) que no desmontan al cambiar.
  - `components/admin/batch-reason.tsx` (nuevo): motivo único por tanda, persistente en
    `sessionStorage` vía `useSyncExternalStore`, con contador de cambios guardados y "cerrar tanda".
    `useConfigSave` lo hereda y ya no recibe `reason` por formulario; cada formulario muestra
    `BatchReasonNote`. La auditoría y la obligatoriedad quedan intactas.
  - Verificados **786/786 unitarios** (+14: 8 pendientes/embudo, 3 `periodRateBpsFor`, 3 cotización),
    typecheck limpio, lint 0 errores (18 warnings preexistentes), build OK y **browser real**: guard
    de sesión, las cinco pestañas cambian de contenido, el motivo se hereda entre pestañas y sobrevive
    a un F5, la campana muestra 118 pendientes y abre el diálogo con el enlace a la sección.
- **F13-4 HECHO** (la cotización publica la tasa):
  - `server/schedule.ts`: `periodRateBpsFor` (la tasa que cobra el calendario) y `MONTHS_PER_YEAR`,
    extraídas del prorrateo que ya usaba el motor, para que la UI no derive su propia aritmética.
  - `LoanQuote` expone `annualRateBps`, `monthlyRateBps` (anual/12, comparable) y `periodRateBps`
    (anual/periodosPorAño, la que se cobra). Separadas **a propósito**: el producto real es
    quincenal, así que publicar una sola habría hecho que el cliente viera un número que el contrato
    no cobra.
  - `components/credit/loan-application-form.tsx`: muestra tasa mensual, anual y tarifa, aclara la
    equivalencia cuando la frecuencia no es mensual, y nombra la cuota según la frecuencia
    ("cuota quincenal", no "cuota mensual") — el mismo error que llamar mensual a la tasa.
  - Verificado contra el proyecto real (BIWEEKLY, 6000 bps): `periodRateBps: 231`,
    `monthlyRateBps: 500`, y los pesos del plan cuadran con el motor.

### Aviso operativo (F13-3)

La verificación de estos formularios en browser **escribe** en el proyecto real: por eso el QA
restauró producto, montos y umbrales, y borró los artefactos `MICRO_DISB_*`, dejando la tasa v2
activa por decisión del dueño del producto. La verificación de escritura de configuración debe
correrse contra un proyecto de pruebas, no contra `credito-a1b4a`. Detalle en WORKLOG.

---

## FASE 14 — Auditoría (audit)
### Tarea F14-1: Servicio + cobertura completa
- **Acceptance:** `services/audit/` (write-only de facto y por Rules); revisión en cruz con §15: TODAS
  las acciones críticas registradas; no existe ruta de mutación de `audit_logs`.
- **Verify:** test que confirma (1) cada acción de negocio escribe, (2) Rules niegan update/delete.
- **Files:** ~3 + ajustes. **Scope:** M.

### Tarea F14-2: UI de auditoría (solo lectura) + filtros
- **Acceptance:** vista admin read-only con filtros (acción/entidad/usuario/fecha); sin escritura.
- **Verify:** browser. **Files:** ~4. **Scope:** S.

---

## FASE 15 — Notificaciones (notify)
### Tarea F15-1: NotificationService + bandeja
- **Acceptance:** `services/notifications/` con `NotificationProvider` (in-app + log activo; email
  esqueleto activo solo con SMTP configurado), persistencia en `notifications`; eventos del spec
  disparados desde servicios de dominio; bandeja de cliente.
- **Verify:** integración (crear solicitud → notificación in-app) + browser. **Files:** ~6. **Scope:** M.

---

## FASE 16 — Pruebas (end-to-end de calidad)
- [ ] Suite completa unit + integración contra emulador
- [ ] Revisar invariantes críticos §17 del spec y añadir huecos
- [ ] `npm run build` limpio en modo producción
- [ ] Smoke test de reglas/índices de Firestore y Storage; nota de despliegue real (proyecto Firebase,
      service account, plan de pago) documentada como pendiente del usuario
- [ ] Gap-analysis contra criterios de éxito §20

### Checkpoint general — [ ] todos los criterios §20; revisión con humano

---

## FASE 17 — Security review (security-and-hardening)
- [ ] Revisión OWASP orientada: auth/sesiones, RBAC, IDOR, montos, uploads, CSRF/XSS, rate limit,
      idempotencia, secretos, errores, Rules de Firestore/Storage
- [ ] `npm audit` sin vulnerabilidades críticas; pin Next 16.3.6 confirmado
- [ ] Pruebas de abuso: manipulación de monto, doble envío, acceso entre usuarios, RBAC, acceso directo
      a Firestore del cliente denegado por Rules
- [ ] Correcciones + redoc si aplica

## FASE 18 — Browser verification (browser-automation)
- [ ] Flujos principales: registro→login→solicitud→aprobación→desembolso→pago→confirm
- [ ] Dashboard cliente/admin; score explicado; mora; configuración; auditoría
- [ ] Sin errores de consola/red; accesibilidad básica; responsive mobile
- [ ] Screenshots de pantallas clave

## FASE 19 — Code review (code-review-and-quality + code-simplification)
- [ ] Revisión multi-eje; simplificar sin cambiar comportamiento
- [ ] Según git-workflow: commits atómicos (solo si el usuario autoriza commit)
- [ ] Spec/plan actualizados; pendientes (despliegue real, SMTP, jurídico) documentados
- [ ] Entrega con resumen de estado y próximos pasos

---

## 5. Riesgos clave y mitigaciones (resumen)

| Riesgo | Mitigación |
|---|---|
| APIs de Next 16 distintas a lo conocido | Leer `node_modules/next/dist/docs/` antes de cada decisión de framework |
| Next <16.3.6 vulnerable | Pin exacto; `npm audit` en FASE 17 |
| NoSQL sin FK → invasión de invariantes | Transacciones + máquinas de estado + tests de carrera (préstamo activo, idempotencia) |
| Dinero | Pesos enteros con guard `isSafeInteger`; sin céntimos; tests de invariancia |
| Emulador vs producción | Reglas/índices versionados; smoke en proyecto real al desplegar |
| Verdades legales incorrectas | Nada legal en código; config + `PENDING_LEGAL_REVIEW` |
| Tareas gigantes | Slicing vertical; ninguna tarea excede M (L dividido) |

## 6. Preguntas abiertas

Ver §23 de PROJECT_SPEC.md (v2). Este plan se ejecuta **tras la aprobación del usuario**. Primer
slices: F3-1 (scaffold) + F3-2 (Firebase/emulador), verificados antes de continuar.