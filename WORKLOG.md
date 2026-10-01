# Estado de trabajo — FASE 12 (+ regla de plazo)

> Checkpoint para retomar. Actualizado al cierre de FASE 12 (dashboard cliente, verificado en browser)
> y del ajuste de plazo previo a FASE 13.
> Este archivo describe **dónde quedó el trabajo y qué decisiones están abiertas**.
> Las convenciones del proyecto viven en `AGENTS.md`; el plan completo en `IMPLEMENTATION_PLAN.md`.

## Estado: FASE 12 CERRADA (F8–F12 completos y verificados en browser) + REGLA DE PLAZO

| Tarea | Estado |
|---|---|
| F7-2 (UI admin solicitudes) | HECHO |
| F8-1 (loans/installments + invariante) | HECHO |
| F8-2 (generación de cuotas + creación) | HECHO |
| F8-3 (layout cliente "Mis préstamos") | HECHO |
| F9-1 (disbursements + ManualDisbursementProvider) | HECHO |
| F9-2 (UI admin de desembolso) | HECHO — **verificado en browser** |
| F10-1 (colecciones payments + canales) | HECHO |
| F10-2a (crear pago + idempotencia + monto del backend) | HECHO |
| F10-2b (confirmar/rechazar/reversar + recálculo de mora) | HECHO — **verificado en browser** |
| F10-3 (UI cliente: registrar pago + historial) | HECHO — **verificado en browser** |
| F10-4 (cola admin de pagos + decisión humana) | HECHO — **verificado en browser** |
| F11-1 (motor de mora: dominio + servicio) | HECHO |
| F11-2 (recálculo integrado + UI de mora admin) | HECHO — **verificado en browser** |
| F12 (dashboard cliente + bandeja de avisos) | HECHO — **verificado en browser** |
| Ajuste de plazo (pagos mensuales, mínimo 2 cuotas, plazo elegible) | HECHO — **unit 637/637 + typecheck/lint/build limpios** |
| F13-2b (configuración admin: productos/tiers/tasas/umbrales/canales) | HECHO — **unit 772/772 + verificado en browser** |
| F13-3 (rediseño del admin: rail lateral, campana, tabs, motivo por tanda, panel accionable) | HECHO — **unit 786/786 + verificado en browser** |
| F13-4 (tasa visible al solicitar: mensual, anual y por periodo) | HECHO — **unit 786/786 + verificado contra el proyecto real** |

### Rediseño del admin (F13-3)

Lo que se cambió y por qué:

- **El encabezado ya no lleva ocho enlaces de sección.** Pasan al rail lateral, agrupados en
  "Administración" y "Área del cliente". Las notificaciones **se quedan** en el encabezado: son el
  único dato que tiene que ser visible sin desplazarse desde cualquier sección.
- **Campana de pendientes** (`src/services/admin/admin-pending-service.ts`): solicitudes por revisar,
  pagos por confirmar y préstamos por desbloquear. Tres consultas de igualdad (índice automático),
  tope de 200 por cola y `truncated` explícito en vez de un total inventado. Si la lectura falla, el
  admin entero no se cae: la campana queda en cero.
- **Panel accionable.** Antes era una cuadrícula de ceros (la cartera se leía solo de `loans`, y en
  el proyecto real no hay préstamos). Ahora abre con la cola, sigue con el embudo de
  `loan_applications` (`getApplicationFunnel`) y solo después muestra la cartera, con estado vacío
  explícito y tokens `warning` que sí existen en el tema.
- **Configuración en pestañas** (`ConfigWorkspace` + `Tabs`): Producto · Montos · Tasa · Mora ·
  Canales. Los paneles no se desmontan al cambiar de pestaña, así que una edición a medio hacer
  sobrevive al salto.
- **Motivo por tanda.** Se escribe una vez en la barra fija (`BatchReasonProvider`), sobrevive al
  `router.refresh()` y al F5 vía `sessionStorage`, y cada formulario muestra con qué se va a
  guardar (`BatchReasonNote`). La obligatoriedad y la auditoría no cambian: el motivo sigue yendo en
  `audit_logs.metadata.reason` de cada cambio.
- **`useSyncExternalStore` para el motivo guardado**, no `useState` + `useEffect`: leer
  `sessionStorage` en un efecto obligaba a un segundo render que pintaba vacío un motivo que sí
  estaba, y el lint de cascading renders lo marcaba.

### F13-4 — Lo que el cliente ve antes de pedir

Antes el preview mostraba cuota y total; el precio final parecía arbitrario porque no se publicaba
la tasa. Ahora la cotización expone tres cifras, deliberadamente separadas:

| Campo | Qué es | Cómo se calcula |
|---|---|---|
| `annualRateBps` | Tasa anual vigente | la de la versión publicada |
| `monthlyRateBps` | Equivalente mensual comparable | `annualRateBps / 12` |
| `periodRateBps` | Lo que se cobra cada periodo | `annualRateBps / periodosPorAño` |

La separación importa porque el producto real es **quincenal**: con `annualRateBps = 6000` el
mensaje dice 5,00 % mensual y aclara "en este producto cobras 2,31 % por cada quincena". Publicar
solo una de las dos habría hecho que el cliente viera un número que el contrato no cobra.

Verificado contra el proyecto real (BIWEEKLY, 6000 bps): la API devuelve `periodRateBps: 231` y
`monthlyRateBps: 500`, y `interestPesos` cuadra con el plan que genera el motor.

### Incidente: QA de navegador escribió sobre la configuración real

Las pruebas de navegador de esta sesión ejercitaron de verdad los formularios de configuración
—que es justamente lo que había que verificar— y eso **escribió** en el proyecto real. Quedó
registrado en `audit_logs` (motivos "cambio" / "cambio prueba"), y se restauró:

| Documento | Alterado por QA | Restaurado a |
|---|---|---|
| `credit_products/MICRO_BASICO` | MONTHLY, cuotas 2, min 2 / max 3, tarifa 5bps, nombre sin tildes | BIWEEKLY, 4 cuotas, min/max null, tarifa 0, "Microcrédito Básico" |
| `product_tiers/MICRO_BASICO_{1,2,3}` | 20.000 / 50.000 / 75.000 | 50.000 / 75.000 / 100.000 |
| `system_config/delinquency` | 3 / 4 / 15 días | 3 / 15 / 30 días (PROJECT_SPEC §13) |
| `credit_products/MICRO_DISB_*` + sus tasas | artefactos de pruebas anteriores (9999 bps) | borrados |

`interest_rates/MICRO_BASICO_v2` (6000 bps) **se dejó activa** por indicación expresa: es una decisión
de negocio, no un error.

La restauración quedó auditada con su propio `CONFIG_CHANGED` y motivo. La lección operativa: la
verificación de estos formularios debe hacerse contra un proyecto de pruebas, no contra
`credito-a1b4a`.

### Regla de plazo (ajuste previo a FASE 13)

- **Regla de negocio**: la frecuencia pasa a ser **única por producto** (MICRO_BÁSICO = `MONTHLY`) y el
  producto declara `minTermInstallments`/`maxTermInstallments` (mínimo 2). El cliente **elige cuántas
  cuotas** en el formulario (2–6 para MICRO_BÁSICO); nunca la periodicidad.
- `CreditProductDoc` gana `minTermInstallments`/`maxTermInstallments` (zod, `max >= min`, `min >= 2`,
  `termInstallments` dentro del rango). `buildCreditProductDoc` usa defaults 2–6 cuando no se declaran.
- `validateApplicationTerm` en `loan-application.ts`: frecuencia debe ser la del producto y `n` en
  `[min, max]`. Se aplica en `createLoanApplicationDraft` (dominio) y en `createLoanApplication`
  (servicio) con mensajes en español vía `termFrequencyLabel`.
- **Seed**: crea MICRO_BÁSICO mensual 2–6 (`termInstallments` 4 = default del formulario). Además hace un
  **upgrade aditivo** de docs legados sin rango (los migra a mensual 2–6) sin pisar productos ya
  configurados.
- **Cotización honesta**: `GET /api/credit-products/quote` usa la MISMA fuente que la creación real
  (`resolvePricing` + `buildLoanSchedule`) — los pesos del preview coinciden con el calendario que se
  genera al aprobar. Valida monto contra un tier activo y el plazo contra el producto.
- **UI** (`loan-application-form.tsx`): selector de cuotas en cards radio + panel "Así quedará tu plan
  (estimado)" con `aria-live`, cuota mensual, total a pagar, nº de pagos y fecha estimada de la 1ª
  cuota. El `buildRiskContext` sigue estimando la cuota con fee aproximado (5 %) a propósito: es el
  insumo de DTI del scoring y se dejó intacto para no mover scores.
- Nota pendiente: la suite de integración usa la frecuencia del producto sembrado (MONTHLY); los tests
  se actualizaron pero no se corrieron contra el proyecto real en este ajuste.

## Comandos de verificación

```powershell
npm run typecheck
npm test                      # unitarios
npm run test:integration      # contra Firestore REAL, limpia lo que crea
npm run lint
npx tsx scripts/check-test-leftovers.ts   # auditoría de residuos
```

> `npm run test:integration` **con el dev server apagado**: los 11 archivos en paralelo contra un
> mismo proyecto Firestore dan timeouts si además compite `next dev` (no es un fallo de código:
> la misma suite pasa 82/82 en 85 s con el server apagado).

## Decisiones tomadas (no re-litigar sin motivo)

1. **Amortización francesa** (saldo decreciente), elegida por el usuario sobre mi recomendación
   de prorrateo plano. Cuota nivel por fórmula de anidad en `BigInt`; capital creciente; la
   última cuota se queda con el saldo restante. Interés por periodo = `roundDiv(annualRateBps,
   periodos_año)` (redondea a la baja → favorece al cliente). Con tasa 0 se delega en
   `splitAmountPesos` para no tener dos convenciones de residual.
2. **`disbursementDate` opcional** al crear el préstamo. El calendario nace tentativo; el
   desembolso real (F9) lo recalcula. Los importes no dependen de la fecha base: solo se mueven
   los vencimientos. Hay test que lo verifica.
3. **El 500 de `?estado=APPROVED` se arregla con IAM**, no cambiando la query. El usuario
   prefiere no degradar la semántica de la lista.
4. **Tasa y tarifa arrancan en 0** (`PENDING_LEGAL_REVIEW`), así que el caso real de hoy es
   interés 0 y el camino de la francesa se ejercita en tests, no en el seed.

## Decisiones abiertas (bloquean trabajo futuro)

- **Datos preexistentes en el proyecto real** que NO son de test y que no se han tocado: los que
  reporta `check-test-leftovers` como "limpio" pero con total > 0 (`loan_applications` `APP-2026-####`,
  `credit_scores`, `users`, `credit_products`, `risk_rules`, `interest_rates`, `product_tiers`,
  `system_config`) más los 4 `payment_channels` del seed, que son configuración legítima. Preguntado al
  usuario, sin respuesta todavía: ¿se purgan o son data de demostración deliberada?
- **Los `loans` que existían antes del snapshot no tienen `pricing`** (se escribieron antes de que
  existiera el campo). F9-1 los protege: el confirm devuelve 409 y no toca el calendario. Desembolso o
  recálculo de esos préstamos exige una migración de datos autorizada, no un fix de código. Nota: el
  conteo de `loans` del proyecto real es ahora 0, así que este bloque ya no aplica a nada vivo; queda
  como advertencia para el caso de que se restauren datos de una corrida antigua.
- **Seed**: resuelto. `SEED_ADMIN_PASSWORD` (≥12, en `.env`) + `npm run seed` dejan `admin@local.dev`
  con rol ADMIN y los 4 canales. El aviso de "falla por 10 caracteres" que había aquí era viejo.
- **Índices de Firestore**: no se pueden desplegar, el service account no tiene
  `roles/datastore.owner`. Todos los endpoints de deploy devuelven 403. Con el rol:
  `npm run deploy:rules`. F9-1 y F10-2a se libraron de esto: leen por id determinista y el único rango
  (`payments.paymentNumber`) no exige índice compuesto.

## Mapa de lo que se construyó

- `src/server/credit-doc.ts` — shapes + zod + builders de `loans`, `loan_installments` y
  `disbursements`, `ACTIVE_LOAN_STATUSES`, `loanInstallmentDocId`.
- `src/server/schedule.ts` — `splitAmountPesos`, `periodsPerYear`, `addPeriods` (UTC, recorte
  de fin de mes), `buildLoanSchedule` (francesa), `amortizeFrench`, `annuityPayment` (BigInt),
  `assertScheduleIsBalanced` (invariante de suma, compartido por creación y desembolso).
- `src/server/disbursement.ts` — `DisbursementProvider` + `ManualDisbursementProvider`
  (máquina INITIATED→CONFIRMED), `rescheduleDueDates` (devuelve solo `{installmentNumber, dueDate}`).
- `src/services/credit/disbursement-service.ts` — `initiateLoanDisbursement`,
  `confirmLoanDisbursement`, `readInstallments` (un `getAll` por id determinista).
- `src/server/money.ts` — `roundDiv` (bps, .5 alejándose del cero; el signo se trata aparte
  porque `div` trunca hacia −inf).
- `src/server/doc.ts` — `stripUndefined`; Firestore rechaza `undefined` y los builders dejan
  opcionales sin definir. Existían 2 copias privadas de este helper, ahora una.
- `src/services/credit/loan-service.ts` — `resolvePricing`, `findActiveLoanForUser`,
  `assertNoActiveLoan`, `createLoanFromApprovedApplication`, y las lecturas de F8-3:
  `listLoansForUser`, `getLoanForUser`, `listInstallmentsForLoan`, `findNextInstallment`,
  `summarizeLoan`.
- `src/lib/loan-json.ts` — `toIso`/`serializeLoan`/`serializeInstallment` para el JSON de la API.
- `src/lib/credit-labels.ts` — ahora también etiquetas de `LoanStatus`, `InstallmentStatus`,
  `DelinquencyStatus` y `formatDueDate` (UTC).
- `src/app/api/loans/route.ts`, `src/app/api/loans/[id]/route.ts` — lecturas de F8-3.
- `src/components/credit/loans-list.tsx`, `loan-detail.tsx` — UI cliente.
- `src/app/(dashboard)/mis-prestamos/page.tsx`, `mis-prestamos/[id]/page.tsx` — páginas.
- `tests-integration/loan-service.test.ts` — 20 tests, incluida la carrera concurrente.
- `tests-integration/disbursement-service.test.ts` — 7 tests de F9-1 con cleanup autoverificado.
- `src/server/payments.ts` + `src/server/payment-doc.ts` — forma de `payments`/`payment_events` (F10-1),
  y el dominio de F10-2a: `installmentBalance`, `formatPaymentNumber`, `parsePaymentNumberSequence`,
  `normalizePaymentReference`, `assertLoanAcceptsPayments`, `assertPayableInstallment`, `PaymentError`.
- `src/services/payments/payment-service.ts` — `createPayment`, `getPaymentForUser`, `getPaymentForAdmin`.
- `src/app/api/payments/route.ts`, `src/app/api/payments/[id]/route.ts` — F10-2a.
- `tests-integration/payment-service.test.ts` — 7 tests de F10-2a, incluida la carrera de dos pagos
  simultáneos sobre la misma cuota.
- `scripts/check-test-leftovers.ts` — auditoría de residuos.

## Trampas ya pisadas (no repetirlas)

- **Firestore no tiene índices únicos parciales.** El invariante "un préstamo activo" se
  aplica en transacción. Verificado empíricamente: con la comprobación, 1 de 2 creados
  concurrentes pasa; **sin ella pasan los 2**. Ese test se validó desactivando el invariante,
  para probar que no es vacuous. Si alguna vez no serializa, el refuerzo es escribir
  `users/{uid}` en la misma transacción.
- **Los tests de integración dejan basura si no se limpian las escrituras derivadas.** El
  servicio también escribe cuotas y audit logs, que no están en la lista de ids. El cleanup
  los borra por query. Ya se me escapó una vez (24 `loan_installments` huérfanas).
- **`buildLoanApplicationDoc` y compañía devuelven opcionales en `undefined`**; escribir eso
  directo a Firestore revienta. Siempre `stripUndefined`.
- **No des por hecho qué índices existen.** La query `loans [userId, status]` SÍ funciona
  (índice presente) aunque `deploy:rules` falle; `loan_applications [status, createdAt]` NO.
  Verificar, no suponer.
- **El tsconfig va en `target: ES2017`**, sin literales BigInt. Se usa `BigInt(...)`.
- **El directorio `microcredito` está sin trackear** dentro del repo padre: `git status` en el
  padre muestra cambios de hermanos. No tocar hermanos; leer archivos directo.
- PowerShell: no `head`/`tail`/`grep`/`&&`. Los `-replace` largos con `+` y backticks fallan
  de forma poco obvia: usar el editor para ediciones surgicales.
- Me ha pasado colar caracteres chinos en comentarios varias veces: revisar los comentarios
  escritos antes de darlos por buenos.
- **Una fecha de vencimiento es un día concreto, no un instante.** El calendario se calcula en
  UTC a la medianoche; formatearlo con la zona del navegador lo recorre un día (en Colombia,
  el 24/03 se veía como 23/03 19:00). `formatDueDate` fija UTC con `Intl.formatToParts`.
  date-fns v4 no acepta `timeZone` en `format`, y `Intl.format` no garantiza separador:
  armar la fecha con `formatToParts`.
- **Mirar el render encuentra bugs que los tests no ven.** Los dos de F8-3 (fecha corrida y
  "Vencida" en un calendario provisional) ningún test de dominio podía ver: hacer falta el DOM
  y la zona horaria del navegador.
- **`snap.data()` devuelve `Timestamp`, no `Date`.** Los domain types dicen `Date`; en
  integración hay que normalizar (`toDate`) antes de comparar o de llamar `.getTime()`. El error
  sale como `c.dueDate.getTime is not a function`, que parece un bug de production.
- **`Transaction.getAll` es variádico** (`getAll(ref1, ref2)`), no acepta el array: el array da
  error de tipos. El mock de `src/test-utils/firestore-mock.ts` lo imita.
- **Un cleanup que reporta lo que borró está invertido.** La primera versión de
  `tests-integration/disbursement-service.test.ts` listaba como "no se borró" justo los ids que
  el delete sí eliminó, y tendía a fallar siempre. `deleteByQuery` ahora **re-consulta** y
  devuelve lo que sobrevivió, así el cleanup se autoverifica.
- **Un fixture con `undefined` puede caer al default y dar un falso verde.** El test del
  préstamo sin snapshot pasaba `{ pricing: undefined }` y el seed lo sustituía por el snapshot
  por defecto: el guard nunca se ejecutaba y el test pasaba sin probar nada. Ahora la opción es
  `sinPricing: true`, que omite el campo. Cuando un test "debe fallar", hay que confirmar que
  falla por la razón correcta.
- **Los ids de cuota son deterministas** (`${loanId}_${n}`): aprovecharlos para un `getAll`
  evita un query con `where + orderBy` y, por tanto, un índice compuesto que hoy no se puede
  desplegar.

## Decisiones de F8-3

- El loan doc **no** tiene `nextDueAt` y no se le agregó: `summarizeLoan` lo deriva de la
  primera cuota `PENDING` por `dueDate`, y devuelve también `nextInstallmentId` para que la UI
  no compare fechas. Beneficio: cuando F9 recalcule el calendario, el próximo vencimiento se
  mueve solo, sin backfill.
- `listLoansForUser` filtra por `userId` y **ordena en memoria** a propósito: `orderBy` +
  filtro en otro campo pediría el índice compuesto `[userId, createdAt]`, que no se puede
  desplegar (sin `roles/datastore.owner`). Desempate por `id` para que el orden sea estable.
- Ownership 404/403 en la ruta de detalle, igual que en `loan-applications/[id]`. Nota: ese
  patrón **sí revela la existencia** de un id ajeno (403 vs 404). Los ids no son adivinables,
  pero si algún día importa, unificar en 404.
- `userId` viaja al componente cliente solo como clave de refetch: la autorización la hace la
  API con la cookie de sesión. El cliente nunca envía ni decide el uid.
- Mientras el préstamo está en `PENDING_DISBURSEMENT` el calendario es provisional (decisión 2
  de F9), así que la UI **no** marca cuotas como "Vencida" en ese estado.

## Decisiones de F9-1

- **El snapshot de pricing va en `loans.pricing`** (cerrado el punto que bloqueaba F9). Descartado
  leer `audit_logs`: es un rastro append-only, puede podarse y obligaría a leerlo dentro de la
  transacción. `loanDocSchema` es `.strict()`, así que la spec §8.1 se actualizó con el campo.
- **La referencia es obligatoria antes de confirmar**, no opcional "si se conoce". Se acepta al
  iniciar o en la confirmación; sin ella el confirm es 409 y el préstamo sigue
  `PENDING_DISBURSEMENT`. Es la garantía de que nadie marca dinero como movido sin evidencia.
- **Recalcular fechas ≠ recalcular dinero.** `rescheduleDueDates` devuelve solo
  `{installmentNumber, dueDate}` y el servicio escribe únicamente ese campo con `tx.update`. Los
  importes se revalidan contra los totales del préstamo antes de tocar nada
  (`assertInstallmentsMatchLoan`), y el plan rebuilding se valida con `assertScheduleIsBalanced`.
- **El countdown arranca en `disbursedAt`, no en la fecha de aprobación.** Los vencimientos que
  nace con el préstamo son provisionales; por eso el confirm pone `disbursedAt` y recalcula en la
  misma transacción.
- **Préstamos sin snapshot: 409 explícito.** Los 27 loans reales no lo tienen. No se "arregla"
  recalculando con la tasa vigente, porque esa es justo la operación que movería pesos.
- **`metadata.rescheduledInstallments` en el doc de desembolso.** El registro de idempotencia no
  guarda resultados (decisión del sistema), así que el replay reconstruye la respuesta leyendo
  la entidad; este campo es lo que hace eso posible sin cambiar el patrón.
- **`LOAN_DISBURSEMENT_INITIATED` como acción de auditoría propia.** Iniciar y confirmar son
  eventos accountable distintos: "inició A a las 10:00, confirmó B a las 14:00" es exactamente lo
  que hace auditable el doble paso.
- **Cuotas por `getAll` de ids deterministas**, no por query: sin índice compuesto nuevo, y el
  número de cuotas sale del snapshot, no de un conteo.

## Decisiones de F9-2

- **Lecturas admin separadas de las del cliente.** `admin-loan-service.ts` no comparte función con
  `listLoansForUser`/`getLoanForUser` (F8-3), porque esas aplican `assertOwnedBy` para el endpoint
  del cliente. Un admin sí ve préstamos ajenos; si compartieran servicio, un refactor podría
  saltarse la autorización sin que nada lo delatara.
- **Sin endpoints de lectura nuevos.** Las páginas son server components que llaman al servicio
  directo (como ya hacía `/admin/loan-applications`): menos superficie HTTP que auditar y ningún
  `fetch` en el render.
- **Filtro por estado = igualdad de un campo, orden en memoria.** Un `orderBy("createdAt")` con
  `where("status","==",...)` pediría el índice compuesto `[status, createdAt]`, que no se puede
  desplegar por IAM. La igualdad sola usa el índice automático; el desempate por `id` da orden
  estable. Sin filtro: `orderBy createdAt` (índice simple) con tope de 50.
- **La pantalla avisa del legacy antes de transferir, no después.** Sin `loans.pricing` el confirm
  es 409; el botón de iniciar queda deshabilitado con la explicación a la vista, porque descubrirlo
  con un error después de haber movido el dinero es la peor forma de enterarse.
- **El titular se muestra en el detalle.** Es el dato que el admin necesita para no_transferir al
  prestatario equivocado; por eso `getLoanForDisbursement` lee `users/{userId}`.
- **Una clave de idempotencia por diálogo, reutilizada en los reintentos** (patrón de
  `ApplicationDecisionActions`), y botón deshabilitado mientras corre la petición.
- **`server-only` no se puede resolver fuera de Next.** No hay alias para ese paquete en
  `vitest.config.mts`, así que un test que importe un server component no arranca. Por eso la
  cobertura de F9-2 es del **servicio** (unit + integración) y la del render queda para browser.

## Trampas de F9-2 (medidas, no supuestas)

- **`createCustomToken` falla** con `IAM Service Account Credentials API has not been used in
  project 143399026538`: es la API del proyecto del *service account*, no el de Firebase. Es la vía
  técnica para entrar sin contraseña y requiere activar esa API.
- **`updateUser` con contraseña de 10 caracteres** → `auth/invalid-password`. El requisito de ≥12
  del seed no es una manía del código: lo impone el proyecto real.
- **La cuenta admin del proyecto es solo-Google** (`providerData: ["google.com"]`), sin password.
- **`credit_products` no se borraba por `where("productCode", ...)`.** El código de producto es el
  **id** del documento, no un campo: hay que borrar por `__name__`. Por eso el checker de residuos
  ahora incluye `credit_products` y `disbursements`, y mira `loanId`/`productId`/`productType`.
- **Fixture temporal para el browser:** crear y borrar datos reales con un script aparte (no un
  test, que limpia en `afterAll`), con ids `-TEST-` para que `check-test-leftovers` los delate.

## F9-2 verificado en browser (CERRADA)

Recorrido con sesión ADMIN real sobre el fixture `LOAN-F92-TEST-9245AA`, con esperas reales (no
`waitForTimeout`): los cuatro estados se ven bien y el calendario queda correcto.

| Estado | Qué se comprobó |
| --- | --- |
| Sin datos (esqueleto) | `h1` = id, aviso "sin datos", botón **deshabilitado**, "Sin importe registrado", sin 500 |
| Sin iniciar | badges "Pendiente de desembolso" + "Sin iniciar", 4 cuotas provisionales, sin botón de confirmar |
| Modal iniciar | enviar deshabilitado sin referencia; durante el envío el botón queda deshabilitado (guardia de doble clic) |
| Iniciado | muestra referencia, el loan sigue PENDING, aparece "Iniciar y confirmar", el modal se cierra |
| Modal confirmar | referencia precargada, advertencia visible |
| Confirmado | badge "Confirmado" + "Desembolsado", sin botones, cuotas fijadas 10/10, 24/10, 07/11 y 21/11 (14 días) |

Matriz de rutas (todas 200, 0 requests fallidas, 0 errores de consola): `/admin`,
`/admin/loan-applications` con y sin filtro, `/admin/prestamos` con y sin filtro, detalle normal y
detalle esqueleto.

### Dos 500 reales que solo aparecieron al usar la app

1. **`/admin/loan-applications?estado=…` → 500** `FAILED_PRECONDITION: The query requires an index`.
   `listApplicationsForAdmin` (F7-2) hacía `where(status) + orderBy(createdAt)`, que exige el índice
   `[status, createdAt desc]`: está declarado en `firestore.indexes.json` pero **no se puede
   desplegar** sin `roles/datastore.owner`. Con filtro ahora la query es de igualdad pura y el orden
   se resuelve en memoria (desempate por `id`). El test nuevo
   `admin-application-service.test.ts` falla si alguien vuelve a combinar `where` con `orderBy`.
2. **`/admin/prestamos/{esqueleto}` → 500** `RangeError: Valor no es entero seguro: undefined`:
   `formatPesos` se evaluaba al construir el `<Modal>` **cerrado** (la descripción se interpola
   aunque el modal no esté abierto). El componente ahora recibe `principalPesos?: number` y usa
   `formatPesosOrDash`.

### Fuga de datos de test (encontrada al limpiar)

`tests-integration/loan-application.test.ts` sembraba un préstamo con `.add()` (id automático) y su
`afterAll` solo borraba el usuario: **un préstamo huérfano por corrida**. Acumuló 43 documentos
esqueleto en el proyecto real (sin `loanNumber`, sin `pricing`, con un `userId` que no existe en
`users`). Se corrigió registrando el id y borrándolo en `afterAll`, y
`check-test-leftovers` ahora marca cualquier préstamo sin `loanNumber` o con `userId` inexistente,
así la fuga no puede volver a pasar desapercibida. Los 43 se purgaron (todos tenían exactamente la
forma de residuo: 3 campos).

## F10-1: Colecciones de pagos (CERRADA)

Sin UI todavía: es la capa de datos + seed + lectura que F10-2 (servicio) y F10-4 (UI) consumen.

- `src/server/payment-doc.ts` — `payment_channels`, `payments` y `payment_events` (dominio puro,
  sin Firebase/Next), siguiendo el patrón de `credit-doc.ts`: interface + `Build*Input` + schema
  `.strict()` + builder que valida y devuelve el doc.
- `src/services/payments/seed-payment-channels.ts` — los 4 canales de la §11 (transferencia,
  Nequi, QR, Bre-B) con instrucciones **texto estático**; `npm run seed` los crea.
- `src/services/payments/payment-channel-service.ts` — `listActivePaymentChannels` y
  `getActivePaymentChannel`.
- `tests-integration/seed-payment-channels.test.ts` — seed + lectura contra el proyecto real.

**Verificado:** 432/432 unitarios, 87/87 integración (12 archivos), typecheck limpio, lint 0 errores,
0 residuos en el proyecto real. `npm run seed` dos veces seguidas: la segunda crea 0 canales.

### Decisiones de F10-1

- **`payment_channels.type` es un enum del MVP: `BANK_TRANSFER | NEQUI | QR | BREB`, y el doc ID es
  el propio tipo.** La spec §11 nombra los cuatro canales en prosa pero no el enum; el ID fijo hace
  que `payments.channel` sea directamente una referencia válida a `payment_channels` y que un canal
  sea único por tipo. Los datos de la cuenta (banco, número, titular, URL del QR) van en `meta`, que
  es lo que un admin edita cuando hay datos reales. Un tipo fuera del enum no parsea: no se puede
  sembrar un canal "Wompi" que no existe.
- **Un pago nace `PENDING` y el builder no acepta estados terminales.** `buildPaymentDoc` no tiene
  parámetro de estado, así que ningún `CONFIRMED` puede existir sin que alguien lo confirme en F10-2.
  Además el schema rechaza `confirmedBy` sin `confirmedAt` (y `rejectedBy` sin `rejectedAt`): un pago
  "confirmado" sin fecha no se puede auditar ni ordenar.
- **`payment_events/{paymentId}_{n}`, doc ID determinista.** §8.2 no declara índice para
  `payment_events` y desplegar uno exige `roles/datastore.owner` (la trampa de F9-2). Con el ID
  determinista el historial se lee con `getAll` de ids construidos, sin query ni índice. El `n` se
  reserva dentro de la transacción que escribe el evento.
- **`installmentId` se valida contra `loanId` en el builder.** `installmentId` es el doc ID
  determinista `${loanId}_${n}`; sin esa comprobación un pago puede apuntar a la cuota de otro
  préstamo y el saldo que se recalcula al confirmarlo es el de la cuota equivocada.
- **`createdAt`/`updatedAt` en `payment_channels`, aunque §8.1 no los liste.** Las demás colecciones
  de configuración del proyecto sí los tienen (`credit_products`, `risk_rules`, `interest_rates` en
  `credit-doc.ts`); sin ellos no hay forma de saber cuándo un admin cambió las instrucciones de pago.
  Para `payments` el nombre no es una decisión de gusto: §8.1 escribe `created/updated`, pero el
  índice que la propia spec declara es `status+createdAt` (§8.2), así que el campo es `createdAt`.
- **El seed de canales es no destructivo: crea lo que falta y nunca sobrescribe.** Reejecutar
  `npm run seed` no puede borrar las instrucciones que un admin ya cambió por sus datos reales. Los
  índices de `payments` (`status+createdAt`, `userId+status`, `loanId+status`) ya estaban declarados
  en `firestore.indexes.json`: no hizo falta tocarlo.
- **Los datos del seed son demo y lo dicen.** Un número de cuenta inventado en `meta` es el modo de
  fallo peligroso de esta tarea (alguien paga a un número que parece real y el dinero se pierde), así
  que cada canal lleva `meta.demo: true`, `meta.legalReview: "PENDING_LEGAL_REVIEW"` y unas
  instrucciones que abren con "DATOS DE DEMOSTRACIÓN — reemplazar antes de producción". El test
  verifica esos marcadores, y el log del seed avisa. `npm run seed` dice lo mismo al terminar.
- **La lectura de canales no combina `where` con `orderBy`.** Misma razón que F9-2: son 4 docs de
  configuración escritos por un admin, se leen enteros y se filtran/ordenan en memoria. El test
  `nunca combina where con orderBy` falla si alguien lo reintroduce.
- **Un canal desactivado se lee como `null`, no como un error.** Para quien paga, un canal que el
  admin cerró es indistinguible de uno que no existe, y así la UI no ofrece algo que no va a funcionar.

### Dos trampas de F10-1 (medidas, no supuestas)

1. **`Hook timed out in 30000ms` en `disbursement-service.test.ts` (preexistente, no lo causó F10-1).**
   El `afterAll` encadenaba ~56 round trips contra el proyecto real (delete + re-verificación por
   query, 7 préstamos) y se acercaba al límite de 30 s. En aislamiento pasaba; corriendo los 12
   archivos de integración en paralelo, la latencia lo empujaba fuera y el hook moría **con el
   proyecto ya limpio**: un falso positivo que parece un fallo de datos. Se corrigió la causa, no el
   síntoma: la limpieza se reparte por préstamo en paralelo (dentro de cada préstamo el orden sigue
   importando). No se tocó `hookTimeout` ni se saltó ninguna aserción.
2. **Mi propio test de integración fugaba 4 canales al proyecto real.** El test "no sobrescribe un
   canal ya existente" llamaba a `seedPaymentChannels(db)` sin registrar lo que había creado, y su
   `afterEach` no los borraba. Como los ids del seed son fijos (`NEQUI`, `QR`…), **no parecen datos de
   test** y `check-test-leftovers` los reportaba como `limpio`: la fuga era invisible. Es la misma
   fuga que F9-2 encontró en `loan_applications`, en otra colección. Se corrigió estructuralmente con
   un helper `seedTracked()` que **siempre** registra lo que crea, para que ningún test pueda olvidarse;
   los 4 docs se purgaron y se comprobó que después de la corrida `payment_channels total=0`.
   `check-test-leftovers` ahora incluye `payments`, `payment_events` y `payment_channels`, y mira
   `paymentNumber`/`paymentId`/`installmentId` además de `loanNumber`/`loanId`.

### Pendiente de F10-2 (no es de F10-1)

- El saldo del préstamo (`outstandingPesos`, `daysPastDue`, `delinquencyStatus`, PROJECT_SPEC §6.6) lo
  recalcula el servicio de pagos **al confirmar**: el schema ya acepta los campos y el desembolso (F9)
  pone `delinquencyStatus: CURRENT`, pero los números los escribe F10-2b.
- `payments.status` es solo el enum: la **máquina de estados** (PENDING → CONFIRMED | REJECTED,
  CONFIRMED → REVERSED) llega en F10-2b, con la misma honestidad que `ManualDisbursementProvider`: la
  confirmación es siempre humana y **un upload nunca paga**.

---

## F10-2a: Crear pago (CERRADA)

**Qué hace.** `POST /api/payments` (CUSTOMER owner, `Idempotency-Key`) registra un pago **PENDING** de
una cuota: número `PAY-{año}-{consecutivo de 4}`, referencia opcional, canal activo obligatorio, auditoría
`PAYMENT_CREATED` y candado `loan_installments.pendingPaymentId`. `GET /api/payments/:id` lo leen el
titular o un ADMIN. El estado de la cuota **no** cambia al registrar: eso es de F10-2b.

### Decisiones de F10-2a

- **`amountPesos` no existe en el contrato, ni tolerado.** El body Zod es `strict()` y el servicio ni
  siquiera recibe el campo: el pago vale `totalPesos - paidPesos` leído **dentro de la transacción**. La
  diferencia importa por dos motivos: un cliente que manipulase el importe recibe 400 (no un campo
  ignorado en silencio) y, sobre todo, el saldo se calcula con la cuota que se está pagando, no con un
  número que el cliente pudo escribir.
- **`pendingPaymentId` es el candado, y vive en la cuota.** Firestore no tiene `SELECT ... FOR UPDATE`:
  dos POST simultáneos sobre la misma cuota leerían el mismo saldo y ambos escribirían. Escribiendo
  `pendingPaymentId` en la **misma transacción** que crea el pago, el segundo que llega ve el candado
  ocupado y recibe 409. Está verificado en el test de integración, que lanza dos `createPayment` a la vez
  y exige exactamente un fulfilment. La opción descartada era un doc `installment_locks`: más estado que
  mantener y un punto de fallo más, para un bloqueo que cabe en el documento que ya existe.
- **El doc ID del pago es su número, no un `randomUUID()`.** Es lo que ya hace F6 con las solicitudes
  (`APP-{año}-{n}`) y da una propiedad gratis: el replay de una idempotency key puede reconstruir la
  respuesta leyendo `payments/{entityId}` sin guardar el payload. El consecutivo se reserva leyendo el
  máximo del año **dentro de la transacción**; dos registros simultáneos chocan en la misma ruta de doc y
  el perdedor reintenta con el número ya tomado.
- **`withIdempotency` deja que `run` devuelva el `entityId`.** Antes el id tenía que derivarse del `key`
  antes de la transacción, lo cual es imposible cuando el id lo elige la base de datos dentro de ella.
  Ahora `run` puede devolver `{ entityId }`; si no lo hace se usa el `entityId` de entrada, y si no hay
  ninguno se aborta con un error explícito en lugar de dejar una fila de idempotencia que promete una
  entidad que no existe. Se verificó el ciclo completo (replay desde la fila guardada) en integración real.
- **El replay vuelve a verificar la propiedad del préstamo.** La fila de idempotencia tiene una TTL de 24 h;
  si en esa ventana el préstamo se hubiera traspasado, un replay no debe filtrarlo. Es el mismo criterio de
  F9-2 con los desembolsos.
- **Cualquier cuota pendiente es pagable, no solo la próxima.** El backend acepta la cuota 3 aunque la 1
  esté impaga: el saldo de esa cuota es lo que se paga y la confirmación recalcula el préstamo entero. La
  restricción a "la próxima cuota" es de UI (F10-4a), donde además conviene limitarla para no proponer
  una operación que el usuario no entiende.
- **`DEFAULTED` admite pago; `PENDING_DISBURSEMENT`, `PAID` y `WRITTEN_OFF` no.** Estar en mora no es
  estar saldado, y negarle el pago a quien está en mora sería peor que el problema. Pero sí se rechaza el
  pago de un préstamo que aún no recibía dinero: el usuario no tiene nada que haber pagado.
- **`GET /api/payments/:id` reusa el doc del admin para el detalle.** No hay un serializador aparte: la
  ruta arma el mismo DTO en ambos caminos, como ya hacía `/api/loans/:id`. El pago ajeno para un
  CUSTOMER es 404 (no 403): no se le confirma que el pago existe.
- **El rate limit de 20/hora es in-memory por instancia y por cliente.** Es la misma limitación que ya
  aceptamos en los POST de solicitudes; el límite real en un despliegue horizontal vendría del
  `Idempotency-Key` y de los límites de Auth, no de este contador.

### Trampa de F10-2a: los builders dejan `undefined` y Firestore los rechaza

`buildLoanDoc` y `buildLoanInstallmentDoc` dejan los opcionales en `undefined` (no inventan valores), y
escribir un doc así falla con `Cannot use "undefined" as a Firestore value`. Los **servicios** siempre
llaman a `stripUndefined` antes del `.set()`; mi test de integración escribía los docs del escenario
directo, sin esa pasada, y los 7 tests fallaron a la vez. El arreglo fue el del patrón real
(`stripUndefined` en el test), no relajar los schemas ni los builders: son 12 archivos de integración en
paralelo los que convierten un descuido de test en una banda de rojo que parece un bug de pagos.

## F10-2b: Confirmar / rechazar / reversar + recálculo (CERRADA)

**Qué hace.** Un ADMIN resuelve la cita del pago con `POST /api/admin/payments/:id/confirm|reject|reverse`
(`Idempotency-Key`, `requireAdmin`, `assertSameOrigin`). Confirmar pasa la cuota a `PAID`
(`paidPesos = total`), libera el candado, escribe `payment_events/{id}_1`, recalcula **saldo y mora** del
préstamo con el motor de mora (`src/server/delinquency.ts`) y, si era la última cuota impaga, sala el
préstamo (`status PAID`, `paidAt`). Rechazar escribe el motivo, suelta el candado **sin tocar la cuota** y
la devuelve a pagable. Reversar deshace la confirmación (cuota a `PENDING`, `payment_events/{id}_2`) y, si
el préstamo estaba saldado, lo vuelve a activar (borra `paidAt`).

### Decisiones de F10-2b

- **La confirmación revalida el importe contra el saldo actual.** `effectConfirmInstallment` vuelve a
  calcular `totalPesos - paidPesos` y compara con `payment.amountPesos`; si la cuota se movió desde que se
  registró el pago, no se confirma un monto que ya no es cierto (409 con instrucción de re-evaluar).
- **El rechazo y la confirmación liberan el candado, cada uno a su manera.** El candado solo lo liberan esas
  transiciones; sin ese borrado una cuota rechazada quedaría bloqueada para siempre. Confirmar lo suelta
  porque la cuota queda pagada (`FieldValue.delete()` en `pendingPaymentId`); rechazar lo suelta dejando la
  cuota intacta. Reversar borra además `paymentId`/`paidAt` de la cuota.
- **`payment_events` con id determinista `${paymentId}_${n}`.** Reconfirmar/rechazar → `n=1`; reversar →
  `n=2`. Cada transición ocurre como máximo una vez; el guard `assertEventSlotFree` lee el slot dentro de la
  transacción y un segundo intento (aunque venga con otra key) recibe 409. El doc ID determinista evita el
  índice compuesto que §8.2 no declara (trampa de F9-2).
- **El recálculo sale de las cuotas, no del caché.** `recalcLoanDelinquency` lee **todas** las cuotas por id
  determinista (`getAll`, sin query) y suma saldos: `outstandingPesos` nunca se confía en lo que `loans`
  traiga. Se aplica la transición **en memoria** para que el recálculo vea el estado final sin violar la
  regla de Firestore "reads antes de writes" (trampa real que el mock no detecta y que la integración sí).
- **"Saldado" es un dato derivado.** El préstamo pasa a `PAID` solo cuando el recálculo dice
  `outstandingPesos = 0`; un reverso sobre un préstamo `PAID` lo devuelve a `DISBURSED` y borra `paidAt`.
- **El motor de mora es dominio puro** (`src/server/delinquency.ts`, testeado aislado): estados
  `CURRENT|DUE_SOON|DUE_TODAY|OVERDUE|DEFAULT|PAID` con umbrales de `system_config/delinquency`
  (el seed siembra `{dueSoonDays: 3, overdueDays: 1, defaultDays: 30}`). F11-1 lo reutiliza para el recálculo
  bajo demanda y la UI de cartera; falla en voz alta (409) ante datos corruptos (cuota con más pagado que su
  total) y 500 ante una config imposible (no se escribe mora absurda).
- **El reverso se implementa aunque §9 no lo liste.** §11 define `CONFIRMED → REVERSED` y la acceptance de
  F10-2 pide reversar; la API pública lo expone igual (`reverse/route.ts` lo documenta). El doc del pago
  **no** guarda `reversedBy` (PROJECT_SPEC §8.1): el actor del reverso va en el evento y en la auditoría.
- **El mock de Firestore ahora respeta `FieldValue.delete()`.** `update` con sentinels borra la clave en vez
  de guardar el objeto; sin eso los tests nunca habrían ejercitado la liberación real del candado.

### Trampa de F10-2b: Firestore exige todos los reads antes de los writes

`confirmInTransaction`/`reverseInTransaction` leen el pago, el slot de evento, el préstamo y los canales
antes de escribir; el primer intento leía el recálculo **después** del `tx.set`/`tx.update` y la integración
real estalló con *"Firestore transactions require all reads to be executed before all writes"*. El mock no lo
detecta (sus reads no ven writes pendientes), así que se arregló en el servicio aplicando la transición en
memoria: mismas lecturas → cómputo → writes, sin re-leer tras escribir.

## F10-3 y F10-4: UI de pagos (CERRADAS, verificadas en browser)

Recorrido completo probado contra el proyecto real con un usuario y un préstamo de prueba (3 cuotas):

1. El cliente entra al detalle del préstamo y pulsa **Pagar**.
2. Elige canal (los 4 que hay en `payment_channels`), escribe referencia y registra.
3. La cuota queda **"Pago en revisión"** y el historial muestra el pago con estado *Registrado, falta
   revisión*.
4. El admin lo ve en `/admin/pagos` y lo **rechaza** con motivo: desaparece de la cola y el historial
   del cliente pasa a *Rechazado*, y **la cuota vuelve a estar pagable** (el candado se soltó).
5. El cliente registra el pago otra vez (misma cuota) y la UI se actualiza sola.
6. El admin lo **confirma**: la cuota queda `Pagada` con su fecha, el saldo pasa de $102.000 a $68.000,
   "Cuotas pagadas 1 de 3" y el próximo vencimiento salta a la cuota 2.

Todo eso sin recargar a mano y sin errores de consola ni peticiones fallidas.

### Decisiones de F10-3/F10-4

- **El detalle del préstamo lo lee el servidor, no el cliente.** Antes `LoanDetail` pedía
  `/api/loans/:id` y `/api/payments` en un `useEffect`; como los datos vivían en el cliente,
  `router.refresh()` **no actualizaba nada** (el efecto no se re-ejecuta): tras pagar, la tabla seguía
  mostrando "Pagar" y el historial vacío. Ahora `mis-prestamos/[id]/page.tsx` lee el detalle y el
  historial con los servicios (`summarizeLoan`, `listPaymentsForLoan`) y los pasa como props;
  `router.refresh()` vuelve a pedirlos y la UI se actualiza sola. De paso desaparecen el waterfall de
  cliente, el esqueleto de carga y la necesidad de duplicar estado.
- **El `Modal` tiene alto máximo y scroll interno.** No tenía `max-height`, así que un diálogo con los
  cuatro canales crecía más que la ventana y **el pie quedaba fuera de la pantalla**: el botón
  "Registrar pago" no se podía pulsar (en un teléfono, imposible). Ahora el panel es
  `flex max-h-[100dvh] flex-col`, el cuerpo scrollea y el pie se queda fijo; el fondo también scrollea
  y en pantallas bajas el panel se ancla abajo.
- **El historial falla aparte del detalle.** Si `listPaymentsForLoan` falla, la página pasa el mensaje
  y el calendario se sigue viendo con una tarjeta de error en su sección: es peor no mostrar pagos
  que no mostrar el préstamo entero.
- **404 real y no tarjeta de error.** Un préstamo que no existe (o que es de otro) ahora responde 404
  con `notFound()` en vez de un error de red en pantalla.
- **La proyección de props es explícita, sin `as`.** El page mapea campo a campo (fechas ISO,
  opcionales del doc resueltos) porque esa es la frontera de serialización hacia el cliente.
- **`GET /api/loans/:id` se queda.** Sigue siendo API pública documentada y cubierta por integración,
  aunque la página ya no la use: el cliente no la necesita, pero la superficie HTTP no se recorta por
  decisión del UI.

### Trampas de F10-3/F10-4 (medidas, no supuestas)

- **`set-state-in-effect` (lint, error) en `loan-detail.tsx`.** Al pasar el fetch a una función fuera
  del efecto, la regla `set-state-in-effect` de `eslint-plugin-react-hooks` v7 marca la llamada
  aunque el primer `setState` esté después de un `await`. La respuesta no fue silenciar la regla: la
  convención del repo ya era que los datos los traen los Server Components (`admin/pagos` llama al
  servicio directamente), así que el detalle se movió al servidor. El error desaparece y el código
  queda más simple.
- **El radio de canal es `sr-only`.** El input real es invisible (accesible por teclado y lector de
  pantalla) y lo que se pulsa es la etiqueta. `locator.check()` falla con *"element is outside of the
  viewport"*; la forma correcta de automatizarlo es clicar en `label:has(input[type="radio"])`.
- **Los canales se piden al abrir el modal.** Antes de que responda `/api/payment-channels` no hay
  ningún radio en el DOM: esperar al texto "¿Por dónde vas a pagar?" no basta, hay que esperar al
  `input[type="radio"]` (si no, el primer `label` del diálogo es el campo de referencia).

## Home y navegación (hecho, verificado en browser)

`/` tiene dos caras y se decide **en el servidor** leyendo la cookie de sesión:

- **Sin sesión:** la portada pública de siempre (explicación, "Crear cuenta" e "Ingresar").
- **Con sesión:** el **hub** con un botón por área. Un cliente ve *Solicitar préstamo*, *Mis
  solicitudes* y *Mis préstamos*; un ADMIN ve esas tres **más** *Solicitudes*, *Préstamos* y *Pagos*
  de administración, con la insignia "Administrador".

### Decisiones

- **El rol se resuelve en el servidor, no en el cliente.** La cookie de sesión es la fuente del rol
  (`requireUser`); decidir la navegación en el navegador mostraría enlaces que al pulsarlos devuelven
  403. Por eso `/` es dinámica (`ƒ`) y ya no se prerenderiza.
- **Cabecera única (`components/layout/app-header.tsx`).** Los tres sitios que tenían cabecera (home,
  área del cliente, administración) ahora comparten el mismo componente con su lista de enlaces: antes
  cualquier cambio de navegación obligaba a editar tres archivos y el home no tenía ninguno.
- **Los enlaces del admin solo si el rol los permite.** El área del cliente añade "Administración"
  cuando `context.role === ADMIN`; el hub hace lo mismo con la sección completa.
- **En móvil los enlaces bajan a su propia fila** (`order-last` + `w-full`) en vez de desbordar la
  barra; en escritorio se alinean a la derecha como antes. Sin JS: es CSS, no un menú que abrir y
  cerrar.
- **404 en español con salidas** (`app/not-found.tsx` + `not-found-view.tsx`). Se descubrió al probar
  un préstamo que no existía: la respuesta era 404 correcta pero **el cuerpo iba vacío**, porque no
  había `not-found.tsx` en ninguna parte. Ahora ofrece inicio, "Mis préstamos" y registro.

### Dos 404 que solo aparecieron probando (y cómo quedaron)

- **La 404 de la raíz no cubre los grupos con layout.** `notFound()` dentro de `(dashboard)` daba
  404 con cabecera y **cuerpo vacío**: Next renderiza la 404 del segmento, no la de la raíz. Hay un
  `not-found.tsx` en `(dashboard)` y en `admin`, y los tres comparten `NotFoundView` (la raíz
  además envuelve con `AppHeader`, porque no tiene layout propio).
- **`/admin/prestamos/:id` reventaba con 500** al pedir un préstamo inexistente: el servicio lanza
  `notFound(...)`, y ese `AppError` no lo entiende el render de Next ("This page couldn't load"). En
  las rutas HTTP no pasaba porque `toErrorResponse` lo traduce a 404; el salto se comió el 500. Se
  arregla con `rethrowAsNotFound` (`src/lib/next-not-found.ts`), que solo traduce `NOT_FOUND` y deja
  subir el resto — con 4 tests. La página del cliente de préstamos usa el mismo helper.

Verificado en browser: portada anónima (200), hub de cliente (3 tarjetas, sin administración), hub de
admin (6 tarjetas + insignia), las tres páginas destino en 200, la cabecera del área del cliente con
"Administración" para el admin, `/admin/pagos` de un cliente redirigido a `/solicitar` (403), y las
tres 404 (inventada, préstamo inexistente del cliente y del admin) respondiendo 404 con contenido y
sus enlaces. Sin errores de consola en el recorrido autenticado.

## Siguiente: F11 → CERRADA

- **F11-1 (cartera de mora):** recálculo bajo demanda + UI admin de cartera, reutilizando
  `recalcLoanDelinquency` (solo config operativa + query `where(delinquencyStatus)`; el índice se despliega
  con `roles/datastore.owner`).

---

## F11-1: Motor de mora (dominio + servicio) (CERRADA)

**Qué hace.** `src/server/delinquency.ts` es dominio puro: `daysPastDue`, estados
`CURRENT|DUE_SOON|DUE_TODAY|OVERDUE|DEFAULT|PAID` con umbrales de `system_config/delinquency`
(`{dueSoonDays: 3, overdueDays: 1, defaultDays: 30}`, que el seed publica), y `summarizeDelinquency`
con las definiciones de "vencida" y "en mora" de la §13. `src/services/credit/delinquency-service.ts`
arma la cartera: **lectura en fresco sin escribir** (`listDelinquencyForAdmin`, con filtro por estado
sobre el recálculo, no sobre la caché) y **escritura explícita** (`recalcActivePortfolio`, botón que
persiste la caché, dispara avisos de cuota y escribe auditoría). `src/server/loan-recalc.ts` es el
patch de caché compartido con el recálculo del pago (F10-2b).

### Decisiones de F11-1

- **Abrir una pantalla no ensucia la colección.** La página de mora recalcula en memoria y no escribe;
  la escritura es el botón "Recalcular cartera". Un Server Component no muta datos como efecto
  secundario de que alguien mire una tabla. Por eso la fila muestra **las dos columnas**: la mora
  recalculada (lo que es real) y la caché guardada (lo viejo que el botón corregiría). El admin ve la
  mentira y puede decidir.
- **El estado mira la próxima cuota impaga, no el máximo.** `daysPastDue` es el máximo y la clasificación
  sale de la cuota más antigua sin pagar (`delta = wholeDaysBetween(next.dueDate, today)` sobre una
  línea con signo: `>= defaultDays` → DEFAULT, `>= overdueDays` → OVERDUE, `0` → DUE_TODAY, dentro de la
  ventana → DUE_SOON, resto → CURRENT). Con el delta con signo, un vencimiento futuro no se lee como
  "vence hoy".
- **Recálculo en fresco y caché por separado, umbrales como único punto de verdad.** Un préstamo cuyo
  day cambia sin que nadie pague seguiría diciendo `CURRENT` para siempre: ese es el problema que el
  servicio viene a corregir. El estado de los filtros usa el recálculo, nunca la caché, porque el índice
  de `delinquencyStatus` no se puede desplegar (IAM) y además filtraría por el dato viejo.
- **Un préstamo roto no tumba la cartera.** Sin snapshot de pricing o con cuotas faltantes, la fila va
  con `recalc: null` y `error` visible (y al final del orden por urgencia): devolver un saldo a medias
  escribiría una mora que nadie pidió. `summarizeDelinquency` suma solo filas bien calculadas.
- **Avisos idempotentes por doc ID determinista.** Un aviso por cuota, no por día: el ID lleva el número
  de cuota y el estado, así que reavisar cada mañana no llena la bandeja de copias. `refKey` es
  `loanId_n` (solo lo usan los servicios; §16 no lo expone como campo). El sentido del aviso
  (`INSTALLMENT_OVERDUE` vs `INSTALLMENT_DUE_SOON`) sale de `delta` con signo, no de un número escrito.
- **La pasada entera deja una auditoría con el resumen en `metadata`.** Sin `Idempotency-Key` a
  propósito: la operación es idempotente por naturaleza (escribe solo lo que cambia, no duplica avisos),
  pero cada pasada escribe su fila, porque el intervalo entre dos pasadas en el que "no pasó nada" es
  exactamente lo que la auditoría debe poder distinguir.

### Trampa de F11-1 (no gastar el índice que no se tiene)

**Los préstamos activos se leen por igualdad de un campo por estado** (`where("status","==",s)` ×
`ACTIVE_LOAN_STATUSES`, índice automático siempre disponible) y se ordenan en memoria. Un `orderBy`
cruzado pediría el índice compuesto `[status, createdAt]`, que exige `roles/datastore.owner` (trampa de
F9-2). El test de integración verifica que las consultas del servicio corren contra el proyecto real sin
`FAILED_PRECONDITION`.

## F11-2: Recálculo integrado + UI de mora (CERRADA, verificado en browser)

**Qué hace.** `POST /api/admin/delinquency/recalc` (ADMIN, same-origin, rate limit 10/10 min por admin):
sin cuerpo recalcula toda la cartera activa, con `{ loanId }` solo ese préstamo. `/admin/mora` muestra
totales (por cobrar, vencida, en mora, próximas), filtros por estado (pills que enlazan a
`?estado=<status>`), y la tabla con titular, saldo, próxima cuota, atraso, mora recalculada, caché
guardada y botón por fila.

### Lo que se verificó en browser (fixture `-TEST-`, recorrido con sesión ADMIN real)

| Qué se comprobó | Resultado |
| --- | --- |
| 3 préstamos (5 días vencida, vence en 2, 40 días) | filas ordenadas por urgencia (40 → 5 → por vencer), totales $194.418 / vencida $129.612 / en mora $64.806 / próximas $64.806 |
| Filtro `?estado=OVERDUE` y `?estado=DEFAULT` / `DUE_SOON` | cada uno devuelve exactamente su préstamo |
| Columna "Caché guardada" frente a la "Mora" recalculada | cache = "Al día 19:00" mientras el recálculo dice "En mora 40 días": la mentira que el botón corrige, a la vista |
| "Recalcular cartera" (caché envejecida) | toast "3 revisados · 3 con la caché actualizada · 0 avisos nuevos"; la caché termina en "En mora" con hora nueva |
| Segunda pasada seguida | toast "0 con la caché actualizada": idempotencia de facto, el botón no necesita `Idempotency-Key` |
| Botón por fila (caché envejecida) | "quedó guardado con su estado y sus días de atraso" |
| Botón por fila (caché al día) | "ya estaba al día con la caché guardada" |
| Avisos de cuota | 2 `INSTALLMENT_OVERDUE` + 1 `INSTALLMENT_DUE_SOON`, con el texto y el monto correctos; sin duplicados al repetir |
| Auditoría | una fila por pasada con el resumen en `metadata` (`updated`, `notificationsCreated`, `byStatus`…) |

Todo sin errores de consola ni peticiones fallidas. El refresh tras el botón tarda unos segundos **en
dev** (recálculo real contra Firestore + render RSC): latencia, no un bug; la celda de caché llegó a su
valor nuevo con espera del RSC y polling.

### Decisiones de F11-2

- **El rate limit es 10/10 min por admin y el contador es in-memory por instancia.** Cada pasada lee
  cuotas y titulares de hasta 200 préstamos; martillar el botón sería una forma barata de gastar
  lecturas. Se comprobó el 429 real machacando el botón (respuesta con `RATE_LIMITED` y segundos.
  El límite es generoso para uso humano y el doble clic no daña nada (idempotencia).
- **Filtrar por estado sobre el recálculo, no con `where` sobre `loans`.** Es lo de F11-1, ahora con
  evidencia en la UI: un filtro sobre la caché mostraría el préstamo "Al día" que en realidad está
  vencido. El filtro usa la fila ya recalculada en memoria.
- **`URL` desconocida en `?estado=` se ignora** (no rompe la pantalla ni devuelve 500): es entrada de
  usuario. Los valores válidos son exactamente `DELINQUENCY_FILTERS` (los estados menos `PAID`, que no
  tiene sentido en una cartera de activos).
- **El recálculo es idempotente por naturaleza, y la UI lo dice.** El toast de la segunda pasada
  ("0 con la caché actualizada") no es un detalle: es la garantía de que un doble clic (o un recálculo
  programado, que es lo que F13-1 consumirá como base para las métricas) no escribe nada que ya estuviera
  escrito.

### Residuos históricos que se purgaron (y cómo no vuelven)

`check-test-leftovers` encontró **2 préstamos `loan-a-/loan-b-` con sus 4 cuotas, un canal
`CANAL_a_*` y 2 avisos** que no eran de este F11 sino de una **revisión anterior de
`tests-integration/payment-list-service.test.ts`** (la actual limpia bien: corrido en aislamiento, 0
residuos nuevos; la fuga era de una versión que aún no registraba todo lo que sembraba, el patrón
`track()/afterEach` que ya usa). Se purgaron uno a uno y se verificó que tras la corrida completa
`payment_channels total=4` (solo el seed) y `loans total=0`. El propio recorrido del browser también
deja residuo: el QA de mora creó avisos y 9 filas de auditoría `DELINQUENCY_RECALCULATED` con el admin
real (sin `entityId` que las ate al fixture: su `entityType` es `portfolio`); el fixture los borra por
`payload.loanId` y las filas de auditoría se purgaron aparte. Conviene que un QA futuro de esta pantalla
recuerde las dos vías.

## Siguiente: F12 → CERRADA

- **F12 (dashboard cliente):** inicio con estado financiero (préstamo/saldo/siguiente cuota), accesos a
  solicitar/ver/pagar/historial/notificaciones; consistente con el design system; estados vacíos.

---

## F12: Dashboard cliente (CERRADA, verificado en browser)

**Qué hace.** `src/server/client-dashboard.ts` es dominio puro (sin Firebase ni Next): elige el préstamo
activo (invariante de F8: solo puede haber uno), deriva la próxima cuota de la primera PENDING por
vencimiento, calcula los días al vencimiento en UTC (`wholeDaysBetween`, signo incluido) y devuelve una
**unión discriminada por `mode`** (`no_loans` | `no_active` | `active`) que deja tipados los estados
vacíos: en `active` el préstamo SIEMPRE existe. `src/services/credit/client-dashboard-service.ts` lee en
**SOLO lectura** (`listLoansForUser` + cuotas del préstamo activo + avisos por `userId` ordenados en
memoria; índices simples) — abrir la portada o la bandeja no escribe, misma regla que la cartera de F11.

La portada `/` para clientes compone el saludo (`users.fullName`, si no `email`), `ActiveLoanCard`
(saldo pendiente o "por desembolsar", próxima cuota con fecha y días al vencimiento —"Vencida hace N
días" en rojo, "Vence hoy" o "Vence en N días" según el signo—, progreso de cuotas con
`role="progressbar"` accesible, y Ver préstamo + Registrar pago solo cuando aplica), los accesos
rápidos (Registrar pago aparece **solo** con préstamo desembolsado) y los últimos avisos (3, con su
badge y horario). `/mis-notificaciones` es la bandeja **completa**, read-only. El nav de cliente gana
"Notificaciones" (en `NAV_SESION` y en el layout `(dashboard)`) y `NavLinks` (Client Component con
`usePathname`) marca la página actual con `aria-current="page"` y el color primario. Labels de tipo de
aviso en `credit-labels.ts`. Marcar como leído, prioridades y reintentos de envío son de F15-1.

### Verificación en browser (Firestore real)

Fixture temporal (2 clientes, préstamo con 4 cuotas y 2 avisos) creado con los builders de dominio,
recorrido completo y borrado al final: `check-test-leftovers` en **0** (loans 0). Login siempre por la
UI real (`/login` → cookie `__session`), con **cliente A** (DISBURSED, cuota 1 PAID, cuota 2 vencida
hace 2 días, cuotas 3-4 pendientes, 2 avisos) y **cliente B** (sin datos):

| Escenario | Resultado |
| --- | --- |
| Dashboard `/` cliente A | saludo con nombre ("Hola, Diana Prueba"), loanNumber, saldo $210.000, próxima cuota $70.000 "Vencida hace 2 días", progreso "1 de 4", barra accesible, 6 tarjetas de acceso + Ver préstamo + 2× Registrar pago (tarjeta y tile) |
| Avisos en `/` | el más nuevo primero (Cuota 2 vencida → Cuota 3 próxima), con sus badges "Cuota vencida"/"Cuota próxima" |
| Nav | "Inicio" activa en `/`; "Notificaciones" activa en `/mis-notificaciones` (una sola con `aria-current`) |
| `/mis-notificaciones` | 2 avisos completos (sin recortar), sin enlace "Ver todas", sin Registrar pago |
| Dashboard `/` cliente B | estado vacío "Solicita tu primer préstamo", copy de avisos vacío, sin barra de progreso, tarjetas presentes |
| `/solicitar` | el producto carga (ver bug abajo) |

**0 errores de consola y 0 peticiones fallidas** (reporte del runner). 29/29 aserciones del script de
QA; los 3 fallos iniciales eran del propio script (selectores role/case), no de la app.

### Bug preexistente que el QA destapó (y se corrigió)

`solicitar` mostraba "Error al cargar la información del producto": `GET /api/credit-products` 500. La
sonda directa a Firestore dio la causa raíz: la consulta de tiers con `orderBy("position")` exige el
índice compuesto `[isActive, productCode, position]`, **no desplegado** en credito-a1b4a (crear índices
compuestos requiere `roles/datastore.owner`). La consulta equivalente con solo igualdades —la que usa
`loan-application-service` para el scoring— **sí funciona**. Se cambió la ruta a igualdades simples +
orden por `position` en memoria (la convención del proyecto para no 500 por índices, comentada en la
ruta) y se quitó el índice de `firestore.indexes.json` (ningún código lo consulta ya). Verificado en
browser (check "solicitar carga el producto (sin error)").

### Units

- `src/server/client-dashboard.test.ts`: 11 tests del dominio: los tres modos, próxima cuota con
  `daysUntil` en UTC (incluido "vence hoy"), `canRegisterPayment` falso con "saldo pendiente pero sin
  calendario (dato roto)" —este caso cazó un bug real del dominio: `next !== null` comparaba contra
  `undefined`, se cambió a `next !== undefined`—, orden de avisos de más reciente a más viejo, y el
  préstamo activo preferido al último. Suite completa: **623/623** (42 archivos), typecheck y lint
  limpios (0 errores), build OK.

---

## Siguiente: F13

- **F13-1 — MÉTRICAS DE CARTERA HECHO:** dominio `server/portfolio-math.ts` con las **14 métricas
  §13** (cartera total, vigente, vencida, en mora, desembolsado acumulado, recuperado acumulado,
  saldo pendiente, tasa de mora, tasa de recuperación, préstamos activos/pagados/incumplidos,
  pérdida de cartera, rendimiento) y particiones auxiliares (`byLoanStatus`/`byDelinquencyStatus`/
  `byRiskLevel`/`maxDaysPastDue`). El servicio `portfolio-service.ts` lee la **caché** de `loans`
  (5 consultas de igualdad por `status`, sin índices compuestos), hace el **join del riesgo** con
  `credit_scores/{applicationId}` en un `getAll` y aplica **filtros fecha/estado/riesgo/monto/mora**.
  Los préstamos previos al esquema cuentan como `skippedLegacy` y `truncated` avisa si algún estado
  llegó al tope de lectura. Definiciones fijadas en los tests (p.ej. `recuperado = Σ máx(0,
  totalPayable − outstanding)`, `perdida = outstanding de WRITTEN_OFF`, ratios en basis points con
  `roundDiv`; `vigente+vencida = cartera`, `recuperado+saldoPendiente = Σ totalPayable`).
  **Verificado:** **665/665 unitarios** (45 archivos; +11 dominio, +12 servicio), typecheck y lint
  0 errores (15 warnings preexistentes), build OK. La integración contra el proyecto real queda para
  la verificación de F13-2 (Browser), que consume esta API.
- **F13-2a — PANEL ADMIN + USUARIOS/LÍMITE HECHO:** (detalle en la sección de arriba).

---

## F13-2a — Panel admin, usuarios y límite de crédito por usuario

Ajuste de límite por usuario (`user_limit_overrides`, §7.3) + panel de métricas (§13) + pantalla de
usuarios, todo admin-only.

### Decisiones

- **El límite se guarda como documento único `user_limit_overrides/{uid}`**, no como colección de
  eventos. Es idempotente por naturaleza (last-write-wins por uid), así que la ruta POST **no pide
  `Idempotency-Key`** (y por eso tampoco hay clave de idempotencia). El histórico vive en
  `audit_logs`, donde cada cambio deja `LIMIT_CHANGED` (actor, uid, monto nuevo, razón).
- **`findEligibleTier` recibe `creditLimitPesos` como cap, no como reemplazo.** Si el override fuera
  "reemplazo" (un número de crédito que no depende del tier), rompería la lógica de negocio de
  ascenso/descenso por historial que ya existe. Como **cap**, el monto sigue siendo uno de los
  `product_tiers` (los pagos validan contra el tier exacto). El cap se aplica **después** de la
  reducción por incumplimiento: primero la elegibilidad por historial, luego el tope manual del admin.
- **Si el cap no alcanza el tier mínimo, `canApply: false`** con motivo — nunca un tier inventado
  ni un monto parcial (un microcrédito parcial no es un producto).
- **`capTierByCreditLimit` elige el mayor tier activo cuyo monto cabe**; ignora tiers inactivos y
  elige por monto (no solo posición) para no depender del orden de posiciones.
- **`listUsersWithLimits` hace un `getAll` de overrides por uid** (determinista, sin índices
  compuestos) y ordena usuarios por `createdAt desc`.
- **El panel `/admin` es ahora una página propia** (antes redirigía a `/admin/loan-applications`):
  muestra las 14 métricas §13 desde la caché de `loans` (bps → porcentaje), con avisos de
  `truncated`/`skippedLegacy` para no vender métricas parciales como ciertas. Atajos a las colas.
- **Formulario de límite por fila (`UserLimitForm`)** con botón "Quitar" además de "Guardar" (revoción
  → `active: false`, también auditado).

### Archivos

- `src/server/loan-application.ts`: `capTierByCreditLimit` + `findEligibleTier(..., creditLimitPesos?)`.
- `src/services/users/user-limit-service.ts`: `setUserCreditLimit`, `clearUserCreditLimit`,
  `readActiveCreditLimit`, `listUsersWithLimits`.
- `src/services/credit/loan-application-service.ts`: `createLoanApplication` lee el cap activo antes
  de resolver el tier.
- `src/app/api/admin/users/route.ts` (GET), `src/app/api/admin/users/[uid]/limit/route.ts` (POST).
- `src/app/admin/page.tsx` (panel), `src/app/admin/usuarios/page.tsx`, `src/components/admin/user-limit-form.tsx`,
  `src/app/admin/layout.tsx` (nav + "Panel"/"Usuarios").

### Units

- `loan-application.test.ts`: +6 tests del cap (baja al mayor monto que cabe; intacto si alcanza;
  no elegible si no alcanza el mínimo; límite exacto al mínimo; cap sobre tier reducido por
  incumplimiento; ignora tiers inactivos).
- `user-limit-service.test.ts`: 12 tests nuevos (crea override + auditoría; sobrescribe; usuario
  inexistente; montos inválidos/no enteros/no seguros; razón por defecto; revocación marca
  `active:false` + auditoría; no-op sin override; lectura de límite activo/inactivo/ausente; listado
  con límite y orden `createdAt desc`).
- `loan-application-service.test.ts`: +4 tests (baja tier con override; override suficiente; bloqueo
  si no alcanza el mínimo; override inactivo ignorado).
- Suite completa: **687/687 unitarios** (46 archivos), typecheck limpio, lint 0 errores (15
  warnings preexistentes), build OK. Browser/integración pendientes de ejecutar (requieren
  credenciales reales).

---

## F13-2b — Configuración admin (productos, tiers, tasas, umbrales, canales)

Las cinco cosas que un ADMIN puede cambiar del producto y de la operación, en una pantalla, cada
cambio con motivo y con `CONFIG_CHANGED`.

### Decisiones

- **No se crean productos desde la UI.** Se edita el existente por código: un producto nuevo no es
  una edición de configuración, es una migración. `currency`, código, `productCode` y `position`
  quedan inmutables en el dominio.
- **Las tasas no se editan, se versionan.** Editar `annualRateBps` a posteriori cambiaría la
  condición que un cliente aceptó; crear una versión deja la anterior como registro. Solo se
  modifica `isActive`, y por la misma razón los préstamos existentes conservan la tasa con la que
  se crearon.
- **Los umbrales no recalculan los préstamos ya existentes.** `parseThresholdsForWrite` comparte la
  validación del motor (`dueSoonDays < overdueDays`, `defaultDays >= overdueDays`) para que admin y
  motor no puedan discrepar; cambiar umbrales afecta el recálculo futuro, no el pasado.
- **La auditoría va en la misma transacción que el cambio**, siempre: `audit_logs` +
  `AuditAction.CONFIG_CHANGED` + `metadata: { reason, changes }` (el diff real, no el body crudo).
  Un no-op se rechaza con 400 en vez de generar una entrada de auditoría vacía.
- **`dataReplaced: true` es irreversible desde la pantalla** (marca
  `DEMO_REPLACED_PENDING_LEGAL_REVIEW` y borra `meta.demo`). El botón dice
  "Ya son datos reales" y el retorno a demo exige otra decisión consciente.
- **`Idempotency-Key` en las altas de tier y tasa** (`{productCode}_{position}` y
  `{productType}_v{version}` son IDs deterministas): reintentar no duplica.
- **`listAdminConfig` lee con `getAll` y ordena en memoria**, no con `where + orderBy`: el índice
  compuesto no se puede desplegar en el proyecto real sin rol `datastore.owner`, y el conjunto de
  configuración es pequeño por definición.
- **`payment-doc` es la allowlist de `meta` público** de canales, compartida por el servicio de pagos
  (que es lo que ve el cliente) y por la validación del admin. Las **etiquetas en español** viven en
  `src/lib/public-meta-labels.ts`, con `satisfies readonly PaymentChannelPublicMetaKey[]` para que
  agregar una clave al dominio rompa el typecheck de la pantalla en vez de dejar un campo que
  ningún admin puede editar.
- **La pantalla muestra un solo producto.** El negocio tiene uno (una Hipotecaria no aplica a
  microcrédito); con más de uno se parte en tabs por `productCode`, no se inventa un selector.

### Archivos

- `src/server/admin-config.ts`: IDs, parseo, invariantes y `diff`.
- `src/services/admin/admin-config-service.ts`: `listAdminConfig` + 8 mutaciones transaccionales.
- `src/lib/admin-config-request.ts`: ceremonial común (CSRF → sesión → admin → rate limit → Zod) y
  `requireIdempotencyKey`.
- `src/app/api/admin/config/route.ts` + `products/[code]`, `tiers`, `tiers/[tierId]`, `rates`,
  `rates/[rateId]`, `thresholds`, `channels/[channelId]`.
- `src/app/admin/configuracion/page.tsx` + `src/components/admin/{config-form-parts,product-terms-form,
  tier-editor,interest-rates-panel,thresholds-form,channel-forms}.tsx`.
- `src/app/admin/layout.tsx`: nav admin suma "Configuración".

### Units

- `admin-config.test.ts` (nuevo, 34): IDs con código inválido, escalonamiento de montos, producto
  activo sin tier/tasa activa, versionado de tasas, umbrales, transición demo→real y diff de auditoría.
- `admin-config-service.test.ts` (nuevo, 39): escritura+auditoría atómicas, no-ops, preservación de
  `createdAt`, idempotencia (nueva y repetida), fechas y canales; con un mock que **clona los docs
  leídos** para cazar comparaciones por identidad, el bug que Firestore real sí produce.
- `admin-config-request.test.ts` (nuevo, 12): orden de las comprobaciones (CSRF antes que sesión),
  rate limit por admin y 429, body inválido, y `Idempotency-Key` obligatoria en las altas.
- Suite completa: **772/772 unitarios** (49 archivos), typecheck limpio, lint 0 errores (15 warnings
  preexistentes), build OK.

### Browser (proyecto real, sin emulador)

- `/admin/configuracion` sin sesión redirige a `/login` y no renderiza ningún formulario.
- Con `admin@local.dev`: HTTP 200, cinco tarjetas, 11 formularios, 65 inputs, 12 campos de motivo;
  datos reales del seed (`MICRO_BASICO`, tiers 20000/50000, cuatro canales), 0 errores de consola.
- Guardar sin motivo: la validación del cliente lo detiene y **no sale ninguna petición**.
- Guardar con motivo pero sin cambios: `PATCH /api/admin/config/products/MICRO_BASICO` → **400**
  "El cambio no modifica ningún valor", mensaje visible en la tarjeta. El guard de no-op está dentro
  de la transacción, así que esta prueba ejercita sesión, CSRF, rate limit, Zod, servicio y
  transacción contra Firestore real **sin escribir nada**.
- Nota: la red hacia `identitytoolkit.googleapis.com` se cae de vez en cuando desde este entorno y
  el login falla en silencio; no es un fallo de la app.


