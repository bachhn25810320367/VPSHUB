/**
 * VPS Hub — Local Integrated Development & Simulation Server
 * 
 * Serves frontend static files and mirrors Azure Functions serverless API routes:
 * - GET  /api/telemetry/latest
 * - GET  /api/telemetry/history?range=1h|6h|24h|7d
 * - POST /api/telemetry
 * - GET  /api/expenses
 * - POST /api/expenses
 * - PUT  /api/expenses
 * - DELETE /api/expenses?id=...
 * - GET  /api/servers
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 8080;

// In-memory persistent store for development
const memoryStore = {
  servers: [
    {
      id: "vps1",
      name: "vps 1 (Window Server)",
      os: "windows",
      ip: "20.44.176.166",
      location: "Tokyo, JP",
      tunnel_url: "https://vps1.hoangngocbach.id.vn",
      is_online: true,
      pingMs: 14,
      cpu_percent: 2.8,
      memory: { total: 1073741824, used: 260000000, free: 813741824, percent: 24.2 },
      disk: { total: 32212254720, used: 12500000000, free: 19712254720, percent: 38.8 },
      network: { bytes_recv: 3450000000, bytes_sent: 1250000000, speed_rx_bps: 1450000, speed_tx_bps: 480000 },
      last_seen: Math.floor(Date.now() / 1000)
    },
    {
      id: "vps2",
      name: "vps2 (Ubuntu)",
      os: "linux",
      ip: "20.89.130.95",
      location: "East Asia",
      tunnel_url: "https://vps2.hoangngocbach.id.vn",
      is_online: true,
      pingMs: 9,
      cpu_percent: 1.4,
      memory: { total: 1073741824, used: 190000000, free: 883741824, percent: 17.6 },
      disk: { total: 32212254720, used: 8400000000, free: 23812254720, percent: 26.0 },
      network: { bytes_recv: 2150000000, bytes_sent: 820000000, speed_rx_bps: 920000, speed_tx_bps: 230000 },
      last_seen: Math.floor(Date.now() / 1000)
    },
    {
      id: "vps3",
      name: "vps3 (Debian)",
      os: "linux",
      ip: "20.89.131.102",
      location: "Southeast Asia",
      tunnel_url: "https://vps3.hoangngocbach.id.vn",
      is_online: true,
      pingMs: 18,
      cpu_percent: 0.9,
      memory: { total: 1073741824, used: 145000000, free: 928741824, percent: 13.5 },
      disk: { total: 32212254720, used: 5200000000, free: 27012254720, percent: 16.1 },
      network: { bytes_recv: 980000000, bytes_sent: 410000000, speed_rx_bps: 340000, speed_tx_bps: 120000 },
      last_seen: Math.floor(Date.now() / 1000)
    }
  ],
  expenses: [
    {
      id: "exp-1",
      category: "VPS",
      title: "VPS 1 (Tokyo - Windows Server 2022)",
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
      title: "VPS 2 (Ubuntu 22.04 - Beszel Hub)",
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

// Periodic live simulation jitter when real agent is not pushing
setInterval(() => {
  memoryStore.servers.forEach(s => {
    // slight natural fluctuation
    s.cpu_percent = Math.max(0.5, Math.min(98, +(s.cpu_percent + (Math.random() * 0.6 - 0.3)).toFixed(1)));
    s.network.speed_rx_bps = Math.max(80000, Math.round(s.network.speed_rx_bps * (1 + (Math.random() * 0.16 - 0.08))));
    s.network.speed_tx_bps = Math.max(40000, Math.round(s.network.speed_tx_bps * (1 + (Math.random() * 0.16 - 0.08))));
    s.last_seen = Math.floor(Date.now() / 1000);
  });
}, 3000);

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Agent-Secret, Authorization',
    'Cache-Control': 'no-cache'
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method.toUpperCase();

  // Handle CORS Preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Agent-Secret, Authorization'
    });
    return res.end();
  }

  // --- API ROUTE: /api/telemetry/latest ---
  if (pathname === '/api/telemetry/latest' && method === 'GET') {
    const nowSec = Math.floor(Date.now() / 1000);
    const enriched = memoryStore.servers.map(s => ({
      ...s,
      is_online: (nowSec - s.last_seen) < 90
    }));
    return sendJson(res, 200, enriched);
  }

  // --- API ROUTE: /api/telemetry/history ---
  if (pathname === '/api/telemetry/history' && method === 'GET') {
    const range = parsedUrl.query.range || '1h';
    const currentRxMbps = parseFloat((memoryStore.servers.reduce((a, b) => a + b.network.speed_rx_bps, 0) / (1024 * 1024)).toFixed(2));
    const currentTxMbps = parseFloat((memoryStore.servers.reduce((a, b) => a + b.network.speed_tx_bps, 0) / (1024 * 1024)).toFixed(2));

    const rangeConfig = {
      'Live': {
        labels: Array.from({ length: 20 }, (_, i) => `${(19 - i) * 3}s`).reverse(),
        ram: {
          vps1: [94.8, 95.1, 95.4, 94.9, 95.2, 95.6, 95.0, 95.3, 95.5, 95.1, 94.8, 95.2, 95.7, 95.3, 94.9, 95.1, 95.4, 95.2, 95.0, memoryStore.servers[0].memory.percent],
          vps2: [52.8, 53.1, 53.5, 53.0, 53.4, 53.8, 53.2, 53.6, 53.4, 53.1, 52.9, 53.3, 53.7, 53.4, 53.0, 53.2, 53.6, 53.5, 53.2, memoryStore.servers[1].memory.percent],
          vps3: [47.5, 47.8, 48.2, 47.9, 48.0, 48.3, 47.7, 48.1, 47.9, 47.6, 47.4, 47.9, 48.2, 48.0, 47.7, 47.8, 48.1, 48.0, 47.8, memoryStore.servers[2].memory.percent]
        },
        cpu: {
          vps1: [1.2, 1.5, 1.8, 1.4, 1.6, 2.1, 1.5, 1.7, 1.9, 1.3, 1.5, 1.8, 2.2, 1.6, 1.4, 1.7, 1.9, 1.5, 1.3, memoryStore.servers[0].cpu_percent],
          vps2: [0.2, 0.3, 0.4, 0.3, 0.2, 0.4, 0.3, 0.3, 0.4, 0.2, 0.3, 0.4, 0.5, 0.3, 0.2, 0.3, 0.4, 0.3, 0.2, memoryStore.servers[1].cpu_percent],
          vps3: [0.4, 0.5, 0.6, 0.5, 0.4, 0.6, 0.5, 0.6, 0.7, 0.5, 0.4, 0.5, 0.7, 0.6, 0.5, 0.5, 0.6, 0.5, 0.4, memoryStore.servers[2].cpu_percent]
        },
        bandwidth: {
          rx: [1.2, 1.4, 1.6, 1.5, 1.3, 1.7, 1.5, 1.6, 1.8, 1.4, 1.3, 1.5, 1.9, 1.6, 1.4, 1.5, 1.7, 1.6, 1.4, currentRxMbps],
          tx: [0.4, 0.5, 0.6, 0.5, 0.4, 0.6, 0.5, 0.6, 0.7, 0.5, 0.4, 0.5, 0.8, 0.6, 0.5, 0.5, 0.7, 0.6, 0.5, currentTxMbps]
        }
      },
      '1h': {
        labels: ['60m', '50m', '40m', '30m', '20m', '10m', 'Now'],
        ram: {
          vps1: [93.5, 94.2, 95.6, 94.8, 95.1, 95.5, memoryStore.servers[0].memory.percent],
          vps2: [51.8, 52.4, 53.9, 53.0, 52.7, 53.6, memoryStore.servers[1].memory.percent],
          vps3: [46.8, 47.2, 48.5, 48.0, 47.4, 48.1, memoryStore.servers[2].memory.percent]
        },
        cpu: {
          vps1: [1.2, 1.5, 2.4, 1.8, 1.4, 1.6, memoryStore.servers[0].cpu_percent],
          vps2: [0.2, 0.3, 0.5, 0.4, 0.2, 0.3, memoryStore.servers[1].cpu_percent],
          vps3: [0.4, 0.5, 0.8, 0.6, 0.4, 0.5, memoryStore.servers[2].cpu_percent]
        },
        bandwidth: {
          rx: [1.1, 1.4, 2.5, 1.9, 1.4, 1.7, currentRxMbps],
          tx: [0.4, 0.6, 1.0, 0.8, 0.5, 0.7, currentTxMbps]
        }
      },
      '6h': {
        labels: ['6h', '5h', '4h', '3h', '2h', '1h', 'Now'],
        ram: {
          vps1: [88.2, 91.5, 96.8, 97.2, 95.9, 94.8, memoryStore.servers[0].memory.percent],
          vps2: [48.5, 51.0, 58.4, 55.8, 54.0, 53.1, memoryStore.servers[1].memory.percent],
          vps3: [44.0, 45.6, 51.8, 49.8, 48.5, 47.5, memoryStore.servers[2].memory.percent]
        },
        cpu: {
          vps1: [0.9, 1.3, 5.8, 3.4, 2.1, 1.4, memoryStore.servers[0].cpu_percent],
          vps2: [0.2, 0.3, 2.4, 1.5, 0.8, 0.3, memoryStore.servers[1].cpu_percent],
          vps3: [0.3, 0.4, 1.9, 1.1, 0.7, 0.4, memoryStore.servers[2].cpu_percent]
        },
        bandwidth: {
          rx: [0.7, 1.1, 4.8, 3.4, 2.2, 1.6, currentRxMbps],
          tx: [0.3, 0.5, 1.9, 1.3, 0.8, 0.6, currentTxMbps]
        }
      },
      '24h': {
        labels: ['24h', '20h', '16h', '12h', '8h', '4h', 'Now'],
        ram: {
          vps1: [82.4, 85.0, 92.6, 96.5, 95.0, 93.5, memoryStore.servers[0].memory.percent],
          vps2: [42.0, 43.8, 52.5, 58.2, 55.0, 51.2, memoryStore.servers[1].memory.percent],
          vps3: [38.5, 40.0, 47.8, 52.0, 49.2, 46.0, memoryStore.servers[2].memory.percent]
        },
        cpu: {
          vps1: [0.5, 0.4, 1.8, 7.5, 4.8, 2.2, memoryStore.servers[0].cpu_percent],
          vps2: [0.1, 0.1, 0.9, 3.8, 2.4, 0.8, memoryStore.servers[1].cpu_percent],
          vps3: [0.2, 0.2, 0.8, 2.1, 1.5, 0.6, memoryStore.servers[2].cpu_percent]
        },
        bandwidth: {
          rx: [0.4, 0.3, 1.7, 7.1, 5.2, 2.5, currentRxMbps],
          tx: [0.1, 0.1, 0.6, 2.9, 2.0, 0.9, currentTxMbps]
        }
      },
      '7d': {
        labels: ['7d', '6d', '5d', '4d', '3d', '2d', 'Now'],
        ram: {
          vps1: [78.0, 83.5, 89.2, 95.8, 96.4, 93.8, memoryStore.servers[0].memory.percent],
          vps2: [39.2, 44.0, 48.6, 54.2, 56.8, 50.5, memoryStore.servers[1].memory.percent],
          vps3: [35.0, 38.5, 42.8, 48.0, 49.8, 44.8, memoryStore.servers[2].memory.percent]
        },
        cpu: {
          vps1: [3.8, 4.9, 5.2, 6.1, 4.4, 1.8, memoryStore.servers[0].cpu_percent],
          vps2: [1.8, 2.4, 2.8, 3.2, 2.1, 0.8, memoryStore.servers[1].cpu_percent],
          vps3: [1.1, 1.4, 1.5, 1.9, 1.3, 0.6, memoryStore.servers[2].cpu_percent]
        },
        bandwidth: {
          rx: [4.8, 5.7, 5.1, 6.3, 4.2, 1.6, currentRxMbps],
          tx: [1.9, 2.3, 2.0, 2.5, 1.7, 0.6, currentTxMbps]
        }
      }
    };

    const sel = rangeConfig[range] || rangeConfig['1h'];
    return sendJson(res, 200, {
      range,
      labels: sel.labels,
      ramSeries: sel.ram,
      cpuSeries: sel.cpu,
      bandwidthSeries: sel.bandwidth
    });
  }

  // --- API ROUTE: /api/telemetry (POST Agent Ingestion) ---
  if (pathname === '/api/telemetry' && method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      if (!body.vps_id) return sendJson(res, 400, { error: 'vps_id required' });

      const idx = memoryStore.servers.findIndex(s => s.id === body.vps_id);
      if (idx !== -1) {
        memoryStore.servers[idx] = {
          ...memoryStore.servers[idx],
          ...body,
          last_seen: Math.floor(Date.now() / 1000)
        };
      } else {
        memoryStore.servers.push({
          id: body.vps_id,
          name: body.name || body.vps_id,
          os: body.os || 'linux',
          ip: body.ip || '0.0.0.0',
          location: 'Remote',
          tunnel_url: `https://${body.vps_id}.hoangngocbach.id.vn`,
          is_online: true,
          pingMs: 12,
          cpu_percent: body.cpu_percent || 1.0,
          memory: body.memory || { total: 1073741824, used: 200000000, free: 873741824, percent: 18.6 },
          disk: body.disk || { total: 32212254720, used: 8000000000, free: 24212254720, percent: 24.8 },
          network: body.network || { bytes_recv: 0, bytes_sent: 0, speed_rx_bps: 0, speed_tx_bps: 0 },
          last_seen: Math.floor(Date.now() / 1000)
        });
      }
      return sendJson(res, 200, { success: true, vps_id: body.vps_id });
    } catch (e) {
      return sendJson(res, 400, { error: 'Invalid JSON' });
    }
  }

  // --- API ROUTE: /api/expenses ---
  if (pathname === '/api/expenses') {
    if (method === 'GET') {
      const items = [...memoryStore.expenses].sort((a, b) => (a.dueDate > b.dueDate ? 1 : -1));
      const totalMonthlyVnd = items
        .filter(i => i.billingCycle === 'monthly' || !i.billingCycle)
        .reduce((sum, i) => sum + (Number(i.amount) || 0), 0);
      const unpaid = items.filter(i => i.status === 'unpaid');

      return sendJson(res, 200, {
        items,
        summary: {
          totalMonthlyVnd,
          totalItems: items.length,
          unpaidCount: unpaid.length,
          nextDue: unpaid.length > 0 ? unpaid[0].dueDate : null
        }
      });
    }

    if (method === 'POST') {
      const body = await parseJsonBody(req);
      const item = {
        id: body.id || `exp-${Date.now()}`,
        category: body.category || 'VPS',
        title: body.title || 'VPS Node',
        amount: Number(body.amount) || 0,
        currency: 'VND',
        billingCycle: body.billingCycle || 'monthly',
        dueDate: body.dueDate || new Date().toISOString().split('T')[0],
        status: body.status || 'unpaid',
        createdAt: new Date().toISOString()
      };
      memoryStore.expenses.push(item);
      return sendJson(res, 201, { success: true, item });
    }

    if (method === 'PUT') {
      const body = await parseJsonBody(req);
      const idx = memoryStore.expenses.findIndex(i => i.id === body.id);
      if (idx !== -1) {
        memoryStore.expenses[idx] = { ...memoryStore.expenses[idx], ...body };
        return sendJson(res, 200, { success: true, item: memoryStore.expenses[idx] });
      }
      return sendJson(res, 404, { error: 'Not found' });
    }

    if (method === 'DELETE') {
      const id = parsedUrl.query.id;
      if (!id) return sendJson(res, 400, { error: 'id required' });
      memoryStore.expenses = memoryStore.expenses.filter(i => i.id !== id);
      return sendJson(res, 200, { success: true, id });
    }
  }

  // --- API ROUTE: /api/servers ---
  if (pathname === '/api/servers' && method === 'GET') {
    return sendJson(res, 200, memoryStore.servers);
  }

  // --- STATIC FILE SERVING (frontend/) ---
  let filePath = path.join(__dirname, 'frontend', pathname === '/' ? 'index.html' : pathname);
  
  // Fallback to index.html for SPA
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(__dirname, 'frontend', 'index.html');
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      return res.end('Error loading ' + pathname);
    }
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.png': 'image/png',
      '.svg': 'image/svg+xml'
    };
    res.writeHead(200, {
      'Content-Type': mimeTypes[ext] || 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache'
    });
    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log('================================================================');
  console.log(`🚀 VPS Hub Local Server running at http://localhost:${PORT}`);
  console.log(`📡 Mirroring Azure Functions & Cosmos DB serverless APIs`);
  console.log(`📊 Open http://localhost:${PORT} in your browser to view dashboard`);
  console.log('================================================================');
});
