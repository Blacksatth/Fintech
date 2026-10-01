import "dotenv/config";
import { createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const projectId = process.env.FIREBASE_PROJECT_ID ?? "";
const credsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "";

if (!projectId || !credsPath || !existsSync(credsPath)) {
  throw new Error("FIREBASE_PROJECT_ID y GOOGLE_APPLICATION_CREDENTIALS son obligatorias. Revisa .env.");
}

const sa = JSON.parse(readFileSync(credsPath, "utf8"));

function readProjectFile(name: string): string {
  const file = path.join(process.cwd(), name);
  if (!existsSync(file)) {
    throw new Error(`No existe ${name}`);
  }
  return readFileSync(file, "utf8");
}

const b64url = (input: string): string => Buffer.from(input, "utf8").toString("base64url");

async function getAccessToken(): Promise<string> {
  if (sa.project_id !== projectId) {
    throw new Error(`La cuenta de servicio pertenece a "${sa.project_id}", no a "${projectId}".`);
  }
  const privateKey = sa.private_key.replace(/\\n/g, "\n");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  )}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey).toString("base64url");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }),
  });
  if (!res.ok) {
    throw new Error(`No se obtuvo token OAuth (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

async function api(
  token: string,
  url: string,
  init?: { method: string; body: unknown },
): Promise<{ status: number; data: unknown }> {
  const res = await fetch(url, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!res.ok) {
    throw new Error(`API ${url} -> ${res.status}: ${text.slice(0, 400)}`);
  }
  return { status: res.status, data };
}

async function publishRuleset(token: string, fileName: string, content: string): Promise<string> {
  const { data } = await api(token, `https://firebaserules.googleapis.com/v1/projects/${projectId}/rulesets`, {
    method: "POST",
    body: {
      source: {
        files: [{ name: fileName, content }],
        language: "FIREBASE_RULES",
      },
    },
  });
  return (data as { name: string }).name;
}

async function publishRelease(token: string, releaseId: string, rulesetName: string): Promise<void> {
  const name = `projects/${projectId}/releases/${releaseId}`;
  await api(token, `https://firebaserules.googleapis.com/v1/${name}`, {
    method: "PATCH",
    body: {
      release: { name, rulesetName },
      updateMask: "rulesetName",
    },
  });
  console.log(`[deploy] release ${releaseId} -> ${rulesetName}`);
}

function indexKey(collectionGroup: string, fields: Array<{ fieldPath: string; order: string }>): string {
  const sorted = fields
    .map((f) => `${f.fieldPath}:${f.order}`)
    .sort();
  return `${collectionGroup}|${sorted.join(",")}`;
}

async function deployIndexes(token: string): Promise<void> {
  const indexesFile = readProjectFile("firestore.indexes.json");
  const desired = (JSON.parse(indexesFile) as {
    indexes: Array<{ collectionGroup: string; queryScope: string; fields: Array<{ fieldPath: string; order: string }> }>;
  }).indexes;

  const listUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/collectionGroups/-/indexes`;
  const res = await api(token, listUrl);
  const existing = ((res.data as { indexes?: Array<{ name: string; queryScope: string; fields: Array<{ fieldPath: string; order: string }> }> })
    .indexes ?? []).map((i) => ({
    key: indexKey("", i.fields),
    name: i.name,
    fields: i.fields,
  }));
  const existingKeys = new Set(existing.map((e) => e.key));

  for (const desiredIndex of desired) {
    const key = indexKey(desiredIndex.collectionGroup, desiredIndex.fields);
    if (existingKeys.has(key)) {
      console.log(`[deploy] indice ya existe: ${key}`);
      continue;
    }
    try {
      const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/collectionGroups/${desiredIndex.collectionGroup}/indexes`;
      await api(token, url, {
        method: "POST",
        body: { queryScope: desiredIndex.queryScope, fields: desiredIndex.fields },
      });
      console.log(`[deploy] indice creado: ${key}`);
    } catch (err) {
      console.warn(`[deploy] AVISO indice ${key}: ${(err as Error).message}`);
    }
  }
}

async function verifyRelease(token: string, releaseId: string): Promise<void> {
  const name = `projects/${projectId}/releases/${releaseId}`;
  const { data } = await api(token, `https://firebaserules.googleapis.com/v1/${name}`);
  const release = data as { rulesetName?: string };
  console.log(`[deploy] verificacion: ${releaseId} -> ${release.rulesetName ?? "sin ruleset"}`);
}

async function main(): Promise<void> {
  const token = await getAccessToken();
  console.log(`[deploy] autenticado como ${sa.client_email}`);

  const firestoreRules = readProjectFile("firestore.rules");

  const fsRuleset = await publishRuleset(token, "firestore.rules", firestoreRules);
  await publishRelease(token, "cloud.firestore", fsRuleset);

  await deployIndexes(token);
  await verifyRelease(token, "cloud.firestore");
  console.log("[deploy] OK: reglas Firestore publicadas; revisa los AVISOS de indices si quedaron.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[deploy] FAILED:", err);
    process.exit(1);
  });