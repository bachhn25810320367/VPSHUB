import { CosmosClient, Database, Container } from "@azure/cosmos";

let cosmosClient: CosmosClient | null = null;
let database: Database | null = null;
let metricsContainer: Container | null = null;
let expensesContainer: Container | null = null;

const connString = process.env.COSMOS_DB_CONNECTION_STRING || "";

// In-memory fallback for local development or testing without Azure credentials
export const memoryStore = {
  metrics: new Map<string, any[]>(),
  expenses: [
    {
      id: "exp-1",
      category: "VPS",
      title: "VPS 1 (Kuala Lumpur - Windows Server 2022)",
      amount: 140000,
      currency: "VND",
      billingCycle: "monthly",
      dueDate: "2026-09-20",
      status: "paid",
      createdAt: new Date().toISOString()
    },
    {
      id: "exp-2",
      category: "VPS",
      title: "VPS 2 (Debian 12)",
      amount: 140000,
      currency: "VND",
      billingCycle: "monthly",
      dueDate: "2026-09-25",
      status: "unpaid",
      createdAt: new Date().toISOString()
    },
    {
      id: "exp-3",
      category: "VPS",
      title: "VPS 3 (Debian 12 - Storage Worker)",
      amount: 140000,
      currency: "VND",
      billingCycle: "monthly",
      dueDate: "2026-10-02",
      status: "unpaid",
      createdAt: new Date().toISOString()
    },
    {
      id: "exp-4",
      category: "Domain",
      title: "Domain hoangngocbach.id.vn",
      amount: 0,
      currency: "VND",
      billingCycle: "yearly",
      dueDate: "2027-09-01",
      status: "paid",
      createdAt: new Date().toISOString()
    }
  ]
};

export async function initCosmos() {
  if (metricsContainer && expensesContainer) {
    return { metricsContainer, expensesContainer, isFallback: false };
  }

  if (!connString || connString.includes("your-cosmos-account") || connString === "") {
    return { metricsContainer: null, expensesContainer: null, isFallback: true, memoryStore };
  }

  try {
    if (!cosmosClient) {
      cosmosClient = new CosmosClient(connString);
    }
    const dbResponse = await cosmosClient.databases.createIfNotExists({ id: "vps_hub" });
    database = dbResponse.database;

    // vps_metrics container: partitionKey /vps_id and TTL of 7 days (604800 seconds)
    const metricsResponse = await database.containers.createIfNotExists({
      id: "vps_metrics",
      partitionKey: { paths: ["/vps_id"] },
      defaultTtl: 604800 // 7 days automatic cleanup by Cosmos DB (zero cost)
    });
    metricsContainer = metricsResponse.container;

    // expenses container: partitionKey /category
    const expensesResponse = await database.containers.createIfNotExists({
      id: "expenses",
      partitionKey: { paths: ["/category"] }
    });
    expensesContainer = expensesResponse.container;

    return { metricsContainer, expensesContainer, isFallback: false };
  } catch (err) {
    console.warn("Could not connect to Cosmos DB, using local in-memory fallback:", err);
    return { metricsContainer: null, expensesContainer: null, isFallback: true, memoryStore };
  }
}
