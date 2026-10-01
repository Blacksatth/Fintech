<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Microcredito — convenciones del proyecto

## Framework
- This is Next.js 16 (breaks with older rules). Always read the relevant guide in
  `node_modules/next/dist/docs/` before writing framework code.

## Comandos
- Dev: `npm run dev`
- Build / lint / typecheck: `npm run build` | `npm run lint` | `npm run typecheck`
- Unit: `npm test` (vitest run)
- Conexión Firestore real (smoke): `npm run smoke`
- Almacenamiento de comprobantes real (smoke): `npm run smoke:cloudinary` (requiere las tres
  `CLOUDINARY_*` en `.env`; sube un asset `authenticated`, comprueba que la ruta sin firma no
  entrega nada, que la firmada sí, y lo borra)
- Desplegar reglas/índices al proyecto real: `npm run deploy:rules` (usa el service account; index debe tener rol `roles/datastore.owner`)
- Seed (proyecto real, requiere .env): `npm run seed` (crea/garantiza el admin de desarrollo
  `admin@local.dev`; la contraseña viene de `SEED_ADMIN_PASSWORD` en `.env`, nunca del código)
- Integración: `npm run test:integration` (requiere .env con credenciales reales; corre contra el
  proyecto real y **limpia los datos que crea**)

## Firebase
- La documentación oficial de Firebase y el README de firebase-admin 14.x son la fuente para el uso del SDK.
- El Admin SDK se usa SOLO en servidor (route handlers/servicios). El cliente NUNCA escribe Firestore.
- Conexión directa al proyecto real `credito-a1b4a` via `GOOGLE_APPLICATION_CREDENTIALS` (NUNCA commiteado).
- Sin Firebase Storage: los comprobantes de pago van a **Cloudinary** (entrega restringida + URLs
  firmadas). Las credenciales `CLOUDINARY_*` viven en `.env` (NUNCA commiteado).
- Reglas e índices de Firestore se versionan en `firestore.rules` y `firestore.indexes.json` y se
  despliegan con `npm run deploy:rules`. La creación de índices compuestos requiere rol
  `roles/datastore.owner` en el service account (Storage ya no aplica: no hay bucket).

## Moneda y negocio
- Todos los importes son pesos enteros COP en `amountPesos` (ver `src/server/money.ts`). Nunca floats
  ni céntimos. Guard `Number.isSafeInteger` en toda operación.
- Toda operación de dinero/estado: idempotencia (`Idempotency-Key`) + auditoría (`audit_logs`) +
  notificación donde aplique. Confirmaciones de pago/desembolso SIEMPRE humanas.

## Auth y sesión (F4-2)
- El navegador autentica **solo** contra Firebase Auth con el Web SDK (`src/lib/firebase-web.ts`): la
  contraseña nunca pasa por el servidor. El cliente NUNCA escribe Firestore.
- `POST /api/auth/session` cambia el ID token por la cookie `__session` (httpOnly, SameSite=Lax,
  `secure` en producción, 5 días) y `GET /api/auth/session` la verifica (`checkRevoked: true`).
- Verificar la sesión es `verifySessionCookieForRequest` en `src/server/auth-session.ts` (devuelve `null`
  ante error); logout = `revokeAllSessions` + borrar cookie. Mutaciones con `assertSameOrigin` (403).
- **El reloj del sistema debe estar sincronizado** con NTP: `revokeRefreshTokens` sella
  `tokensValidAfterTime` con el reloj local, así que con desfase (medido: ~46 s) la revocación tarda en
  aplicarse. Si una prueba de revocación falla, mide el desfase antes de tocar el código.
- `firebase-tools` es solo devDependency (CLI) y arrastra 9 avisos de `npm audit` preexistentes; el
  upgrade a `firebase-tools@15` es semver major, queda **aplazado** (no bloquea el MVP).

## Regla de calidad
- Si una prueba falla: DETENER, investigar la causa raíz. No desactivar el test, no eliminar
  validaciones, no hacer hacks.
