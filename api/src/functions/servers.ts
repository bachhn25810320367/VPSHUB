import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";

const SERVERS_CONFIG = [
  {
    id: "vps1",
    name: "VPS 1 (Tokyo)",
    os: "Windows Server 2022",
    ip: "20.44.176.166",
    location: "Tokyo, Japan",
    tunnelUrl: "https://vps1.hoangngocbach.id.vn",
    quotaGB: 100, // Azure Egress Free Tier
    ramMB: 1024,
    cpuCores: "1 Core / 2 Threads (EPYC 7763)"
  },
  {
    id: "vps2",
    name: "VPS 2 (Ubuntu)",
    os: "Ubuntu 22.04 LTS",
    ip: "20.89.130.95",
    location: "East Asia",
    tunnelUrl: "https://vps2.hoangngocbach.id.vn",
    quotaGB: 100,
    ramMB: 1024,
    cpuCores: "1 Core / 2 Threads (EPYC 7763)"
  }
];

export async function serversHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  return {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=3600"
    },
    jsonBody: SERVERS_CONFIG
  };
}

app.http("servers", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "servers",
  handler: serversHandler
});
