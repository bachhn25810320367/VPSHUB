import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";

const SERVERS_CONFIG = [
  {
    id: "vps1",
    name: "VPS 1 (Kuala Lumpur)",
    os: "Windows Server 2022",
    ip: "85.211.193.75",
    location: "Kuala Lumpur, Malaysia",
    tunnelUrl: "https://vps1.hoangngocbach.id.vn",
    quotaGB: 100, // Azure Egress Free Tier
    ramMB: 1024,
    cpuCores: "1 Core / 2 Threads (EPYC 7763)"
  },
  {
    id: "vps2",
    name: "VPS 2 (Debian)",
    os: "Debian 12",
    ip: "20.196.198.124",
    location: "Seoul, South Korea",
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
