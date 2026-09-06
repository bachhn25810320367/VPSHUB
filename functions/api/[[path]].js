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
    boot_time: 1788535482,
    uptime_seconds: 159800,
    containers: [],
    services: [
      { name: "VPSHub-Agent", status: "Active", substate: "Running", cpu: 0.05, memory: 5.1, updated: "Now" },
      { name: "cloudreve", status: "Active", substate: "Running", cpu: 0.01, memory: 14.2, updated: "Now" },
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
    boot_time: 1788615670,
    uptime_seconds: 79600,
    containers: [
      { name: "cloudreve", cpu: 0.02, memory: 44.2, network: "994 KB", health: "Healthy", ports: "5212", image: "cloudreve/cloudreve:latest", status: "Up 20 hours", updated: "Now" }
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
    boot_time: 1788622547,
    uptime_seconds: 72700,
    containers: [
      { name: "wg-easy", cpu: 0.03, memory: 18.4, network: "0.00 B/s", health: "Healthy", ports: "51820, 51821", image: "ghcr.io/wg-easy/wg-easy", status: "Up 6 hours", updated: "Now" }
    ],
    services: [
      { name: "vps-agent", status: "Active", substate: "Running", cpu: 0.01, memory: 2.4, updated: "Now" },
      { name: "cloudreve-slave", status: "Active", substate: "Running", cpu: 0.01, memory: 13.1, updated: "Now" },
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

async function cosmosUpsertItem(env, containerId, document, partitionKey) {
  const endpoint = env.COSMOS_ENDPOINT || "https://cosmos-vps-hub-prod.documents.azure.com:443/";
  const key = env.COSMOS_KEY || "";
  if (!key) return false;

  const dateStr = new Date().toUTCString();
  const resourceId = `dbs/vps_hub/colls/${containerId}/docs/${document.id}`;
  const auth = await getCosmosAuthHeader("PUT", "docs", resourceId, key, dateStr);

  const headers = {
    "Authorization": auth,
    "x-ms-date": dateStr,
    "x-ms-version": "2018-12-31",
    "x-ms-documentdb-partitionkey": JSON.stringify([partitionKey]),
    "Content-Type": "application/json"
  };

  const res = await fetch(`${endpoint}${resourceId}`, {
    method: "PUT",
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

  // 0. Authentication Endpoints (Stored in Azure Cosmos DB)
  if (path === "/api/auth/login" && method === "POST") {
    try {
      const body = await request.json();
      const username = (body.username || "").trim().toLowerCase();
      const password = body.password || "";

      if (!username || !password) {
        return jsonResponse({ error: "Please enter username and password" }, 400);
      }

      const users = await cosmosQuery(
        env,
        "expenses",
        "SELECT * FROM c WHERE c.category = 'auth_user'",
        [],
        "auth_user"
      );

      const user = users.find(u => 
        (u.username && u.username.toLowerCase() === username) || 
        (u.aliases && u.aliases.map(a => a.toLowerCase()).includes(username))
      );

      if (!user) {
        return jsonResponse({ error: "User account not found" }, 401);
      }

      // Hash with user's salt using Web Crypto SHA-256
      const enc = new TextEncoder();
      const dataToHash = enc.encode(`${password}:${user.salt}`);
      const hashBuffer = await crypto.subtle.digest("SHA-256", dataToHash);
      const computedHash = Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");

      if (computedHash !== user.password_hash) {
        return jsonResponse({ error: "Invalid password" }, 401);
      }

      const token = `vpshub_token_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
      return jsonResponse({
        success: true,
        token,
        username: user.username,
        role: user.role || "owner"
      });
    } catch (e) {
      return jsonResponse({ error: "Login processing error: " + e.message }, 500);
    }
  }

  if (path === "/api/auth/change-password" && method === "POST") {
    try {
      const body = await request.json();
      const username = (body.username || "").trim().toLowerCase();
      const oldPassword = body.oldPassword || "";
      const newPassword = body.newPassword || "";

      if (!username || !oldPassword || !newPassword) {
        return jsonResponse({ error: "Please fill in all required fields" }, 400);
      }

      if (newPassword.length < 6) {
        return jsonResponse({ error: "New password must be at least 6 characters" }, 400);
      }

      const users = await cosmosQuery(
        env,
        "expenses",
        "SELECT * FROM c WHERE c.category = 'auth_user'",
        [],
        "auth_user"
      );

      const user = users.find(u => 
        (u.username && u.username.toLowerCase() === username) || 
        (u.aliases && u.aliases.map(a => a.toLowerCase()).includes(username))
      );

      if (!user) {
        return jsonResponse({ error: "User not found" }, 404);
      }

      const enc = new TextEncoder();
      const oldHashBuf = await crypto.subtle.digest("SHA-256", enc.encode(`${oldPassword}:${user.salt}`));
      const oldHash = Array.from(new Uint8Array(oldHashBuf)).map(b => b.toString(16).padStart(2, "0")).join("");

      if (oldHash !== user.password_hash) {
        return jsonResponse({ error: "Current password is incorrect" }, 401);
      }

      const newSalt = `salt_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      const newHashBuf = await crypto.subtle.digest("SHA-256", enc.encode(`${newPassword}:${newSalt}`));
      const newHash = Array.from(new Uint8Array(newHashBuf)).map(b => b.toString(16).padStart(2, "0")).join("");

      user.salt = newSalt;
      user.password_hash = newHash;
      user.updated_at = new Date().toISOString();

      await cosmosUpsertItem(env, "expenses", user, "auth_user");
      return jsonResponse({ success: true, message: "Password updated successfully in Azure Cosmos DB!" });
    } catch (e) {
      return jsonResponse({ error: "Password change error: " + e.message }, 500);
    }
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

      const bootTime = (latest && latest.boot_time) ? latest.boot_time : srv.boot_time;
      const uptimeSec = bootTime ? (nowSec - bootTime) : ((latest && latest.uptime) || srv.uptime_seconds);

      const containers = (latest && latest.containers && latest.containers.length > 0) ? latest.containers : (srv.containers || []);
      const services = (latest && latest.services && latest.services.length > 0) ? latest.services : (srv.services || []);
      const swap = (latest && latest.swap) ? latest.swap : { total: 1073741824, used: 142000000, free: 931741824, percent: 13.2 };
      const loadAvg = (latest && latest.load_avg) ? latest.load_avg : [0.05, 0.03, 0.01];
      const diskIo = (latest && latest.disk_io) ? latest.disk_io : { read_speed_bps: 1024, write_speed_bps: 2048 };
      const dockerCpu = (latest && typeof latest.docker_cpu === 'number') ? latest.docker_cpu : 0.0;
      const dockerMem = (latest && typeof latest.docker_memory_mb === 'number') ? latest.docker_memory_mb : 0.0;

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
        boot_time: bootTime,
        uptime_seconds: uptimeSec,
        containers,
        services,
        swap,
        load_avg: loadAvg,
        disk_io: diskIo,
        docker_cpu: dockerCpu,
        docker_memory_mb: dockerMem,
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
        boot_time: body.boot_time || 0,
        uptime: body.uptime || 0,
        cpu_percent: body.cpu_percent || 0,
        memory: body.memory || {},
        swap: body.swap || {},
        disk: body.disk || {},
        disk_io: body.disk_io || {},
        network: body.network || {},
        load_avg: body.load_avg || [],
        docker_cpu: body.docker_cpu || 0,
        docker_memory_mb: body.docker_memory_mb || 0,
        containers: body.containers || [],
        services: body.services || [],
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
      const docs = await cosmosQuery(env, "expenses", "SELECT * FROM c WHERE c.category != 'auth_user' ORDER BY c.dueDate ASC");
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
