import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { initCosmos, memoryStore } from "../cosmosClient.js";

export async function expensesHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const method = request.method.toUpperCase();
  const { expensesContainer, isFallback } = await initCosmos();

  if (method === "GET") {
    let items: any[] = [];
    if (isFallback || !expensesContainer) {
      items = [...memoryStore.expenses];
    } else {
      try {
        const { resources } = await expensesContainer.items.readAll().fetchAll();
        items = resources;
      } catch (err) {
        context.error("Cosmos DB expenses query error:", err);
        items = memoryStore.expenses;
      }
    }

    items.sort((a, b) => (a.dueDate > b.dueDate ? 1 : -1));

    const totalMonthlyVnd = items
      .filter((i) => i.billingCycle === "monthly" || !i.billingCycle)
      .reduce((sum, i) => sum + (Number(i.amount) || 0), 0);

    const unpaidItems = items.filter((i) => i.status === "unpaid");

    return {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache"
      },
      jsonBody: {
        items,
        summary: {
          totalMonthlyVnd,
          totalItems: items.length,
          unpaidCount: unpaidItems.length,
          nextDue: items.length > 0 ? items[0].dueDate : null
        }
      }
    };
  }

  if (method === "POST") {
    let body: any;
    try {
      body = await request.json();
    } catch {
      return { status: 400, jsonBody: { error: "Invalid JSON body" } };
    }

    const newItem = {
      id: body.id || `exp-${Date.now()}`,
      category: body.category || "VPS",
      title: body.title || "VPS Node",
      amount: Number(body.amount) || 0,
      currency: body.currency || "VND",
      billingCycle: body.billingCycle || "monthly", // monthly, yearly, once
      dueDate: body.dueDate || new Date().toISOString().split("T")[0],
      status: body.status || "unpaid", // paid, unpaid
      notes: body.notes || "",
      createdAt: new Date().toISOString()
    };

    if (isFallback || !expensesContainer) {
      memoryStore.expenses.push(newItem);
    } else {
      await expensesContainer.items.create(newItem);
    }

    return {
      status: 201,
      headers: { "Access-Control-Allow-Origin": "*" },
      jsonBody: { success: true, item: newItem }
    };
  }

  if (method === "PUT") {
    let body: any;
    try {
      body = await request.json();
    } catch {
      return { status: 400, jsonBody: { error: "Invalid JSON body" } };
    }

    if (!body.id) {
      return { status: 400, jsonBody: { error: "Item ID is required" } };
    }

    if (isFallback || !expensesContainer) {
      const idx = memoryStore.expenses.findIndex((i) => i.id === body.id);
      if (idx !== -1) {
        memoryStore.expenses[idx] = { ...memoryStore.expenses[idx], ...body };
      }
    } else {
      await expensesContainer.items.upsert(body);
    }

    return {
      status: 200,
      headers: { "Access-Control-Allow-Origin": "*" },
      jsonBody: { success: true, item: body }
    };
  }

  if (method === "DELETE") {
    const id = request.query.get("id");
    const category = request.query.get("category") || "VPS";

    if (!id) {
      return { status: 400, jsonBody: { error: "id parameter is required" } };
    }

    if (isFallback || !expensesContainer) {
      memoryStore.expenses = memoryStore.expenses.filter((i) => i.id !== id);
    } else {
      await expensesContainer.item(id, category).delete();
    }

    return {
      status: 200,
      headers: { "Access-Control-Allow-Origin": "*" },
      jsonBody: { success: true, message: "Deleted" }
    };
  }

  return { status: 405, jsonBody: { error: "Method not allowed" } };
}

app.http("expenses", {
  methods: ["GET", "POST", "PUT", "DELETE"],
  authLevel: "anonymous",
  route: "expenses",
  handler: expensesHandler
});
