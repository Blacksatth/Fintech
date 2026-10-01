import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: ["tests-integration/**/*.test.ts"],
    environment: "node",
    setupFiles: ["./tests-integration/setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,

    /**
     * Los archivos se ejecutan **uno a uno**, contra el mismo proyecto real.
     *
     * No es una medida de rendimiento: `payments/{paymentNumber}` se numera leyendo el consecutivo
     * del año, así que dos archivos que crean pagos a la vez compiten por el mismo número y una
     * aserción como "el segundo pago es el primero + 1" depende de que nadie más escriba entre
     * medias. Con `payment-service` y `receipt-service` creando pagos en paralelo, ese test
     * fallaba de forma intermitente. Serializar cuesta unos minutos por corrida y deja las
     * aserciones intactas, que es lo que importa en dinero.
     */
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});