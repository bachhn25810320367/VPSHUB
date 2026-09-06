import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { initCosmos, memoryStore } from "../cosmosClient.js";

const DEFAULT_SERVERS = [
  { id: "vps1", name: "VPS 1 (Tokyo - Windows Server 2022)", os: "windows", tunnelUrl: "https://vps1.hoangngocbach.id.vn" },
  { id: "vps2", name: "VPS 2 (Ubuntu 22.04 - Beszel)", os: "linux", tunnelUrl: "https://vps2.hoangngocbach.id.vn" },
  { id: "vps3", name: "VPS 3 (Debian 12 - Worker)", os: "linux", tunnelUrl: "https://vps3.hoangngocbach.id.vn" }
];

export async function telemetryLatestHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const { metricsContainer, isFallback } = await initCosmos();
  const nowSec = Math.floor(Date.now() / 1000);
  const result: any[] = [];

  for (const srv of DEFAULT_SERVERS) {
    let latestMetric: any = null;

    if (isFallback || !metricsContainer) {
      const list = memoryStore.metrics.get(srv.id);
      if (list && list.length > 0) {
        latestMetric = list[0];
      }
    } else {
      try {
        const querySpec = {
          query: "SELECT TOP 1 * FROM c WHERE c.vps_id = @vpsId ORDER BY c.timestamp DESC",
          parameters: [{ name: "@vpsId", value: srv.id }]
        };
        const { resources } = await metricsContainer.items.query(querySpec).fetchAll();
        if (resources.length > 0) {
          latestMetric = resources[0];
        }
      } catch (err: any) {
        context.warn(`Error querying latest metric for ${srv.id}:`, err);
      }
    }

    const isOnline = latestMetric ? (nowSec - latestMetric.timestamp <= 90) : false;

    if (!latestMetric) {
      latestMetric = {
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
      ...latestMetric,
      is_online: isOnline,
      tunnel_url: srv.tunnelUrl,
      last_seen_seconds_ago: nowSec - (latestMetric.timestamp || nowSec),
      azure_quota_gb: 100 // 100 GB Azure Egress limit
    });
  }

  return {
    status: 200,
    headers: {
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*"
    },
    jsonBody: result
  };
}

app.http("telemetryLatest", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "telemetry/latest",
  handler: telemetryLatestHandler
});
