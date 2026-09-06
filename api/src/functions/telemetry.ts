import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { initCosmos, memoryStore } from "../cosmosClient.js";

export async function telemetryHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const secretKey = process.env.AGENT_SECRET_KEY || "secret-token-change-me";
  const incomingSecret = request.headers.get("x-agent-secret") || request.headers.get("authorization")?.replace("Bearer ", "");

  if (secretKey && incomingSecret !== secretKey) {
    return {
      status: 401,
      jsonBody: { error: "Unauthorized: Invalid agent secret" }
    };
  }

  let body: any;
  try {
    body = await request.json();
  } catch (err) {
    return {
      status: 400,
      jsonBody: { error: "Invalid JSON body" }
    };
  }

  if (!body.vps_id) {
    return {
      status: 400,
      jsonBody: { error: "vps_id is required" }
    };
  }

  const document = {
    id: `${body.vps_id}_${body.timestamp || Date.now()}`,
    vps_id: body.vps_id,
    name: body.name || body.vps_id,
    os: body.os || "unknown",
    timestamp: body.timestamp || Math.floor(Date.now() / 1000),
    cpu_percent: body.cpu_percent,
    memory: body.memory,
    disk: body.disk,
    network: body.network,
    ttl: 604800 // 7 days TTL (Cosmos DB automatic clean up)
  };

  const { metricsContainer, isFallback } = await initCosmos();

  if (isFallback || !metricsContainer) {
    const list = memoryStore.metrics.get(body.vps_id) || [];
    list.unshift(document);
    if (list.length > 50) list.pop(); // keep last 50 samples
    memoryStore.metrics.set(body.vps_id, list);
  } else {
    try {
      await metricsContainer.items.upsert(document);
    } catch (err: any) {
      context.error("Failed to insert metric into Cosmos DB:", err);
      return {
        status: 500,
        jsonBody: { error: "Cosmos DB insert error", details: err.message }
      };
    }
  }

  return {
    status: 200,
    jsonBody: { success: true, vps_id: body.vps_id }
  };
}

app.http("telemetry", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "telemetry",
  handler: telemetryHandler
});
