import { type Firestore } from "firebase-admin/firestore";
import { RuleBasedRiskEngine, createDefaultRiskEngine, ScoreResult, RiskContext } from "@/server/risk-engine";
import { buildCreditScoreDoc, CreditScoreDoc } from "@/server/credit-doc";
import { AuditAction } from "@/server/types";

export interface ScoringDeps {
  db: Firestore;
  riskEngine?: RuleBasedRiskEngine;
  auditLog?: (action: AuditAction, metadata: Record<string, unknown>) => Promise<void>;
}

export interface ScoringInput {
  userId: string;
  applicationId?: string;
  riskContext: RiskContext;
}

export async function calculateAndSaveScore(
  deps: ScoringDeps,
  input: ScoringInput,
): Promise<ScoreResult> {
  const engine = deps.riskEngine ?? createDefaultRiskEngine();
  const result = await engine.calculate(input.riskContext);

  const scoreDoc = buildCreditScoreDoc({
    userId: input.userId,
    applicationId: input.applicationId,
    score: result.score,
    riskLevel: result.riskLevel,
    factors: result.factors,
    modelVersion: result.modelVersion,
    calculatedAt: result.calculatedAt,
  }, new Date());

  // Filtrar campos undefined para Firestore
  const cleanScoreDoc = Object.fromEntries(
    Object.entries(scoreDoc).filter(([, v]) => v !== undefined)
  );

  const scoreId = input.applicationId
    ? `${input.applicationId}`
    : `${input.userId}_${result.calculatedAt.getTime()}`;

  await deps.db.collection("credit_scores").doc(scoreId).set(cleanScoreDoc);

  if (deps.auditLog) {
    await deps.auditLog("SCORE_CALCULATED", {
      userId: input.userId,
      applicationId: input.applicationId,
      score: result.score,
      riskLevel: result.riskLevel,
      modelVersion: result.modelVersion,
    });
  }

  return result;
}

export async function getCreditScore(
  deps: ScoringDeps,
  userId: string,
  applicationId?: string,
): Promise<CreditScoreDoc | null> {
  const scoreId = applicationId
    ? applicationId
    : userId; // Si no hay applicationId, buscar el más reciente por userId

  let snap;
  if (applicationId) {
    snap = await deps.db.collection("credit_scores").doc(scoreId).get();
    if (!snap.exists) return null;
    return snap.data() as CreditScoreDoc;
  }

  // Buscar el score más reciente del usuario
  const scoresSnap = await deps.db
    .collection("credit_scores")
    .where("userId", "==", userId)
    .orderBy("calculatedAt", "desc")
    .limit(1)
    .get();

  if (scoresSnap.empty) return null;
  return scoresSnap.docs[0].data() as CreditScoreDoc;
}