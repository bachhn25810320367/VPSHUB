/**
 * Cloudflare Pages Functions — Unified API Handler for VPS Hub
 * Directly connects Cloudflare Edge to Azure Cosmos DB NoSQL via REST API (Web Crypto)
 * Zero external dependencies, runs at Cloudflare Edge in Vietnam (<10ms).
 */

const DEFAULT_SERVERS = [
  {
    id: "vps1",
    name: "WindowServer",
    hostname: "vaxlouvm",
    os: "windows",
    os_display: "Windows Server 2022 Datacenter",
    cpu_model: "AMD EPYC 7763 64-Core Processor (2)",
    ip: "20.44.176.166",
    location: "Tokyo, JP",
    tunnelUrl: "https://vps1.hoangngocbach.id.vn",
    uptime_seconds: 158200,
    containers: [],
    services: [
      { name: "VPSHub-Agent", status: "Active", substate: "Running", cpu: 0.05, memory: 5.1, updated: "Now" },
      { name: "cloudreve", status: "Active", substate: "Running", cpu: 0.01, memory: 14.2, updated: "Now" },
      { name: "beszel-agent", status: "Active", substate: "Running", cpu: 0.02, memory: 12.8, updated: "Now" },
      { name: "9router (Node.js)", status: "Active", substate: "Running", cpu: 0.08, memory: 78.5, updated: "Now" },
      { name: "sshd", status: "Active", substate: "Running", cpu: 0.01, memory: 4.8, updated: "Now" }
    ]
  },
  {
    id: "vps2",
    name: "Ubuntu",
    hostname: "vlinuxvm",
    os: "linux",
    os_display: "Ubuntu 22.04.5 LTS",
    cpu_model: "AMD EPYC 7763 64-Core Processor (2)",
    ip: "20.89.130.95",
    location: "East Asia",
    tunnelUrl: "https://vps2.hoangngocbach.id.vn",
    uptime_seconds: 77800,
    containers: [
      { name: "cloudreve", cpu: 0.02, memory: 74.2, network: "4.2 KB/s", health: "Healthy", ports: "5212", image: "cloudreve/cloudreve:latest", status: "Up 18 hours", updated: "Now" },
      { name: "beszel", cpu: 0.01, memory: 31.0, network: "1.1 KB/s", health: "Healthy", ports: "8080", image: "henrygd/beszel:latest", status: "Up 21 hours", updated: "Now" },
      { name: "beszel-agent", cpu: 0.01, memory: 15.6, network: "0.2 KB/s", health: "Healthy", ports: "45876", image: "henrygd/beszel-agent:latest", status: "Up 21 hours", updated: "Now" }
    ],
    services: [
      { name: "vps-agent", status: "Active", substate: "Running", cpu: 0.01, memory: 0.9, updated: "Now" },
      { name: "cloudflared", status: "Active", substate: "Running", cpu: 0.05, memory: 29.2, updated: "Now" },
      { name: "docker", status: "Active", substate: "Running", cpu: 0.02, memory: 42.6, updated: "Now" },
      { name: "tailscaled", status: "Active", substate: "Running", cpu: 0.01, memory: 30.0, updated: "Now" },
      { name: "sshd", status: "Active", substate: "Running", cpu: 0.01, memory: 3.5, updated: "Now" }
    ]
  },
  {
    id: "vps3",
    name: "Debian",
    hostname: "debianvm",
    os: "linux",
    os_display: "Debian GNU/Linux 12 (bookworm)",
    cpu_model: "AMD EPYC 7763 64-Core Processor (2)",
    ip: "172.197.200.15",
    location: "Malaysia West",
    tunnelUrl: "https://vps3.hoangngocbach.id.vn",
    uptime_seconds: 71100,
    containers: [
      { name: "wg-easy", cpu: 0.03, memory: 18.4, network: "0.00 B/s", health: "Healthy", ports: "51820, 51821", image: "ghcr.io/wg-easy/wg-easy", status: "Up 6 hours", updated: "Now" }
    ],
    services: [
      { name: "vps-agent", status: "Active", substate: "Running", cpu: 0.01, memory: 2.4, updated: "Now" },
      { name: "cloudreve-slave", status: "Active", substate: "Running", cpu: 0.01, memory: 13.1, updated: "Now" },
      { name: "beszel-agent", status: "Active", substate: "Running", cpu: 0.01, memory: 15.8, updated: "Now" },
      { name: "cloudflared", status: "Active", substate: "Running", cpu: 0.04, memory: 25.5, updated: "Now" },
      { name: "docker", status: "Active", substate: "Running", cpu: 0.02, memory: 71.7, updated: "Now" },
      { name: "sshd", status: "Active", substate: "Running", cpu: 0.01, memory: 3.2, updated: "Now" }
    ]
  }
];

async function getCosmosAuthHeader(verb, resourceType, resourceId, keyBase64, dateStr) {
  const payload = `${verb.toLowerCase()}\n${resourceType.toLowerCase()}\n${resourceId}\n${dateStr.toLowerCase()}\n\n`;
  const binaryKey = Uint8Array.from(atob(keyBase64), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    binaryKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(payload));
  const sigBase64 = btoa(String.fromCharCode(...new Uint8Array(sigBuffer)));
  return encodeURIComponent(`type=master&ver=1.0&sig=${sigBase64}`);
}

async function cosmosQuery(env, containerId, query, parameters = [], partitionKey = null) {
  const endpoint = env.COSMOS_ENDPOINT || "https://cosmos-vps-hub-prod.documents.azure.com:443/";
  const key = env.COSMOS_KEY || "";
  if (!key) return [];

  const dateStr = new Date().toUTCString();
  const resourceId = `dbs/vps_hub/colls/${containerId}`;
  const auth = await getCosmosAuthHeader("POST", "docs", resourceId, key, dateStr);

  const headers = {
    "Authorization": auth,
    "x-ms-date": dateStr,
    "x-ms-version": "2018-12-31",
    "x-ms-documentdb-isquery": "true",
    "Content-Type": "application/query+json"
  };
  if (partitionKey) {
    headers["x-ms-documentdb-partitionkey"] = JSON.stringify([partitionKey]);
  }

  const res = await fetch(`${endpoint}dbs/vps_hub/colls/${containerId}/docs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, parameters })
  });

  if (!res.ok) {
    return [];
  }
  const data = await res.json();
  return data.Documents || [];
}

async function cosmosCreateItem(env, containerId, document, partitionKey) {
  const endpoint = env.COSMOS_ENDPOINT || "https://cosmos-vps-hub-prod.documents.azure.com:443/";
  const key = env.COSMOS_KEY || "";
  if (!key) return false;

  const dateStr = new Date().toUTCString();
  const resourceId = `dbs/vps_hub/colls/${containerId}`;
  const auth = await getCosmosAuthHeader("POST", "docs", resourceId, key, dateStr);

  const headers = {
    "Authorization": auth,
    "x-ms-date": dateStr,
    "x-ms-version": "2018-12-31",
    "x-ms-documentdb-partitionkey": JSON.stringify([partitionKey]),
    "Content-Type": "application/json"
  };

  const res = await fetch(`${endpoint}dbs/vps_hub/colls/${containerId}/docs`, {
    method: "POST",
    headers,
    body: JSON.stringify(document)
  });
  return res.ok;
}

async function cosmosDeleteItem(env, containerId, documentId, partitionKey) {
  const endpoint = env.COSMOS_ENDPOINT || "https://cosmos-vps-hub-prod.documents.azure.com:443/";
  const key = env.COSMOS_KEY || "";
  if (!key) return false;

  const dateStr = new Date().toUTCString();
  const resourceId = `dbs/vps_hub/colls/${containerId}/docs/${documentId}`;
  const auth = await getCosmosAuthHeader("DELETE", "docs", resourceId, key, dateStr);

  const headers = {
    "Authorization": auth,
    "x-ms-date": dateStr,
    "x-ms-version": "2018-12-31",
    "x-ms-documentdb-partitionkey": JSON.stringify([partitionKey])
  };

  const res = await fetch(`${endpoint}${resourceId}`, {
    method: "DELETE",
    headers
  });
  return res.ok;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Agent-Secret, Authorization",
      "Cache-Control": "no-cache"
    }
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  // CORS Preflight
  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-Agent-Secret, Authorization"
      }
    });
  }

  // 1. GET /api/telemetry/latest
  if (path === "/api/telemetry/latest" && method === "GET") {
    const nowSec = Math.floor(Date.now() / 1000);
    const result = [];

    for (const srv of DEFAULT_SERVERS) {
      const docs = await cosmosQuery(
        env,
        "vps_metrics",
        "SELECT TOP 1 * FROM c WHERE c.vps_id = @vpsId ORDER BY c.timestamp DESC",
        [{ name: "@vpsId", value: srv.id }],
        srv.id
      );

      let latest = docs[0];
      const isOnline = latest ? (nowSec - latest.timestamp <= 90) : false;

      if (latest) {
        if (!latest.memory || typeof latest.memory.used !== 'number') {
          latest.memory = { total: 1073741824, used: 0, free: 1073741824, percent: 0 };
        }
        if (!latest.disk || typeof latest.disk.used !== 'number') {
          latest.disk = { total: 32212254720, used: 0, free: 32212254720, percent: 0 };
        }
        if (!latest.network || typeof latest.network.speed_rx_bps !== 'number') {
          latest.network = { bytes_recv: 0, bytes_sent: 0, speed_rx_bps: 0, speed_tx_bps: 0 };
        }
      } else {
        latest = {
          vps_id: srv.id,
          name: srv.name,
          os: srv.os,
          timestamp: nowSec,
          cpu_percent: 0,
          memory: { total: 1073741824, used: 0, free: 1073741824, percent: 0 },
          disk: { total: 32212254720, used: 0, free: 32212254720, percent: 0 },
          network: { bytes_recv: 0, bytes_sent: 0, speed_rx_bps: 0, speed_tx_bps: 0 }
        };
      }

      result.push({
        ...latest,
        name: srv.name,
        hostname: srv.hostname,
        os_display: srv.os_display,
        cpu_model: srv.cpu_model,
        ip: srv.ip,
        location: srv.location,
        is_online: isOnline,
        tunnel_url: srv.tunnelUrl,
        uptime_seconds: (latest && typeof latest.uptime_seconds === 'number' && latest.uptime_seconds > 0) ? latest.uptime_seconds : srv.uptime_seconds,
        containers: srv.containers,
        services: srv.services,
        last_seen_seconds_ago: nowSec - (latest.timestamp || nowSec),
        azure_quota_gb: 100
      });
    }
    return jsonResponse(result);
  }

  // 2. GET /api/telemetry/history
  if (path === "/api/telemetry/history" && method === "GET") {
    const range = url.searchParams.get("range") || "1h";
    let labels = ["60m", "50m", "40m", "30m", "20m", "10m", "Now"];
    if (range === "6h") labels = ["6h", "5h", "4h", "3h", "2h", "1h", "Now"];
    if (range === "24h") labels = ["24h", "20h", "16h", "12h", "8h", "4h", "Now"];
    if (range === "7d") labels = ["7d", "6d", "5d", "4d", "3d", "2d", "Now"];

    return jsonResponse({
      range,
      labels,
      cpuSeries: {
        vps1: [2.1, 2.5, 4.2, 3.1, 2.7, 3.2, 3.5],
        vps2: [1.2, 1.4, 1.8, 1.9, 1.3, 1.6, 1.5],
        vps3: [0.7, 0.8, 1.0, 0.7, 0.9, 0.8, 0.9]
      },
      bandwidthSeries: {
        rx: [1.2, 1.5, 2.1, 1.8, 1.6, 2.0, 2.4],
        tx: [0.5, 0.7, 0.9, 0.8, 0.6, 0.8, 1.1]
      }
    });
  }

  // 3. POST /api/telemetry (Go Agent Ingestion)
  if (path === "/api/telemetry" && method === "POST") {
    const incomingSecret = request.headers.get("X-Agent-Secret") || "";
    const expectedSecret = env.AGENT_SECRET || "hoangngocbach-secret-2026";
    if (incomingSecret !== expectedSecret) {
      return jsonResponse({ error: "Unauthorized: Invalid secret" }, 401);
    }

    try {
      const body = await request.json();
      if (!body.vps_id) return jsonResponse({ error: "vps_id required" }, 400);

      const metricDoc = {
        id: `${body.vps_id}-${Date.now()}`,
        vps_id: body.vps_id,
        name: body.name || body.vps_id,
        os: body.os || "linux",
        timestamp: body.timestamp || Math.floor(Date.now() / 1000),
        cpu_percent: body.cpu_percent || 0,
        memory: body.memory || {},
        disk: body.disk || {},
        network: body.network || {},
        ttl: 604800 // 7 days automatic expiration
      };

      await cosmosCreateItem(env, "vps_metrics", metricDoc, body.vps_id);
      return jsonResponse({ success: true, id: metricDoc.id });
    } catch (e) {
      return jsonResponse({ error: "Invalid JSON: " + e.message }, 400);
    }
  }

  // 4. /api/expenses (CRUD)
  if (path === "/api/expenses") {
    if (method === "GET") {
      const docs = await cosmosQuery(env, "expenses", "SELECT * FROM c ORDER BY c.dueDate ASC");
      const items = docs.length > 0 ? docs : [
        {
          id: "exp-1",
          category: "VPS",
          title: "VPS 1 (Tokyo Win 2022)",
          amount: 140000,
          currency: "VND",
          billingCycle: "monthly",
          dueDate: "2026-09-20",
          status: "paid"
        },
        {
          id: "exp-2",
          category: "VPS",
          title: "VPS 2 (Ubuntu Beszel Hub)",
          amount: 140000,
          currency: "VND",
          billingCycle: "monthly",
          dueDate: "2026-09-25",
          status: "unpaid"
        },
        {
          id: "exp-3",
          category: "VPS",
          title: "VPS 3 (Debian 12 Worker)",
          amount: 140000,
          currency: "VND",
          billingCycle: "monthly",
          dueDate: "2026-10-02",
          status: "unpaid"
        },
        {
          id: "exp-4",
          category: "Domain",
          title: "Domain hoangngocbach.id.vn",
          amount: 0,
          currency: "VND",
          billingCycle: "yearly",
          dueDate: "2027-09-01",
          status: "paid"
        }
      ];

      const totalMonthlyVnd = items
        .filter(i => i.billingCycle === "monthly" || !i.billingCycle)
        .reduce((sum, i) => sum + (Number(i.amount) || 0), 0);
      const unpaid = items.filter(i => i.status === "unpaid");

      return jsonResponse({
        items,
        summary: {
          totalMonthlyVnd,
          totalItems: items.length,
          unpaidCount: unpaid.length,
          nextDue: unpaid.length > 0 ? unpaid[0].dueDate : null
        }
      });
    }

    if (method === "POST") {
      try {
        const body = await request.json();
        const item = {
          id: body.id || `exp-${Date.now()}`,
          category: body.category || "VPS",
          title: body.title || "VPS Expense",
          amount: Number(body.amount) || 0,
          currency: "VND",
          billingCycle: body.billingCycle || "monthly",
          dueDate: body.dueDate || new Date().toISOString().split("T")[0],
          status: body.status || "unpaid",
          createdAt: new Date().toISOString()
        };
        await cosmosCreateItem(env, "expenses", item, item.category);
        return jsonResponse({ success: true, item }, 201);
      } catch (e) {
        return jsonResponse({ error: e.message }, 400);
      }
    }

    if (method === "DELETE") {
      const id = url.searchParams.get("id");
      const category = url.searchParams.get("category") || "VPS";
      if (!id) return jsonResponse({ error: "id required" }, 400);
      await cosmosDeleteItem(env, "expenses", id, category);
      return jsonResponse({ success: true, id });
    }
  }

  // 5. GET /api/servers
  if (path === "/api/servers" && method === "GET") {
    return jsonResponse(DEFAULT_SERVERS);
  }

  return jsonResponse({ error: "Endpoint not found" }, 404);
}
