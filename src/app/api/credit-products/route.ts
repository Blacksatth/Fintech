import { cookies } from "next/headers";
import { getAuthAdmin, getDb } from "@/lib/admin";
import { requireUser } from "@/auth/guards";
import { toErrorResponse } from "@/lib/errors";

export async function GET(): Promise<Response> {
  try {
    const cookieStore = await cookies();
    const db = getDb();
    const auth = getAuthAdmin();

    await requireUser({ auth, db, cookies: cookieStore });

    const productsSnap = await db.collection("credit_products").where("isActive", "==", true).get();
    const products = [];

    for (const productDoc of productsSnap.docs) {
      const productData = productDoc.data();
      // Índice SIMPLE a propósito (igualdades), igual que `loan-application-service`:
      // añadir `orderBy("position")` exigiría el índice compuesto [isActive, productCode,
      // position], que en credito-a1b4a no está desplegado (falta roles/datastore.owner) y
      // devolvería 500. Hay pocos tiers por producto: el orden se resuelve aquí mismo.
      const tiersSnap = await db
        .collection("product_tiers")
        .where("productCode", "==", productDoc.id)
        .where("isActive", "==", true)
        .get();

      const tiers = tiersSnap.docs
        .map((d) => {
          const data = d.data() as { position: number; isActive: boolean };
          return { ...data, id: d.id } as { id: string; position: number; isActive: boolean };
        })
        .sort((a, b) => a.position - b.position);

      products.push({
        id: productDoc.id,
        code: productDoc.id,
        ...productData,
        tiers,
      });
    }

    return Response.json({ products });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}