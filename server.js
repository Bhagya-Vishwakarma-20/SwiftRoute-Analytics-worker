const http = require('node:http');
const crypto = require('node:crypto');
const { prisma } = require('./lib/primaClient');

const PORT = process.env.PORT || 3000;
let server = null;

const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const isAuthorized = (req) => {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Basic ')) return false;
    const decoded = Buffer.from(header.slice(6), 'base64').toString();
    const password = decoded.slice(decoded.indexOf(':') + 1);
    // hash both sides so the buffers are equal length for timingSafeEqual
    const a = crypto.createHash('sha256').update(password).digest();
    const b = crypto.createHash('sha256').update(process.env.DASHBOARD_TOKEN).digest();
    return crypto.timingSafeEqual(a, b);
};

const DAY_MS = 24 * 60 * 60 * 1000;

const getStats = async () => {
    const since24h = new Date(Date.now() - DAY_MS);
    const since30d = new Date(Date.now() - 30 * DAY_MS);

    const [total, last24h, distinct, topLinks, countries, referrers, daily, recent] = await Promise.all([
        prisma.click.count(),
        prisma.click.count({ where: { timestamp: { gte: since24h } } }),
        prisma.$queryRaw`SELECT COUNT(DISTINCT "linkId") AS count FROM "Click"`,
        prisma.click.groupBy({
            by: ['linkId'],
            _count: { _all: true },
            _max: { timestamp: true },
            orderBy: { _count: { linkId: 'desc' } },
            take: 20
        }),
        prisma.click.groupBy({
            by: ['country'],
            _count: { _all: true },
            orderBy: { _count: { country: 'desc' } },
            take: 15
        }),
        prisma.click.groupBy({
            by: ['referrer'],
            _count: { _all: true },
            orderBy: { _count: { referrer: 'desc' } },
            take: 10
        }),
        prisma.$queryRaw`SELECT to_char(date_trunc('day', "timestamp"), 'YYYY-MM-DD') AS day, COUNT(*) AS count
            FROM "Click" WHERE "timestamp" >= ${since30d} GROUP BY 1 ORDER BY 1`,
        prisma.click.findMany({ orderBy: { timestamp: 'desc' }, take: 50 })
    ]);

    const byDay = new Map(daily.map(row => [row.day, Number(row.count)]));
    const perDay = [];
    for (let i = 29; i >= 0; i--) {
        const day = new Date(Date.now() - i * DAY_MS).toISOString().slice(0, 10);
        perDay.push({ day, count: byDay.get(day) || 0 });
    }

    return {
        generatedAt: new Date().toISOString(),
        totalClicks: total,
        clicksLast24h: last24h,
        distinctLinks: Number(distinct[0].count),
        topLinks: topLinks.map(r => ({ linkId: r.linkId, count: r._count._all, lastClick: r._max.timestamp })),
        countries: countries.map(r => ({ country: r.country || 'Unknown', count: r._count._all })),
        referrers: referrers.map(r => ({ referrer: r.referrer || 'Direct / none', count: r._count._all })),
        clicksPerDay: perDay,
        recentClicks: recent.map(c => ({
            timestamp: c.timestamp,
            linkId: c.linkId,
            country: c.country,
            referrer: c.referrer,
            userAgent: c.userAgent,
            ip: c.ip
        }))
    };
};

const fmtTime = (d) => d ? new Date(d).toISOString().replace('T', ' ').slice(0, 19) : '';
const truncate = (s, n) => s && s.length > n ? s.slice(0, n) + '...' : (s || '');

const table = (headers, rows) => `<div class="scroll"><table><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${
    rows.length ? rows.join('') : `<tr><td colspan="${headers.length}" class="muted">No data</td></tr>`
}</tbody></table></div>`;

const renderDashboard = (s) => {
    const max = Math.max(1, ...s.clicksPerDay.map(d => d.count));
    const bars = s.clicksPerDay.map(d =>
        `<div class="bar" title="${escapeHtml(d.day)}: ${d.count}"><span style="height:${Math.round(d.count / max * 100)}%"></span><small>${escapeHtml(d.day.slice(8))}</small></div>`
    ).join('');

    const topLinks = s.topLinks.map(r => `<tr><td class="wrap">${escapeHtml(r.linkId)}</td><td class="num">${r.count}</td><td>${escapeHtml(fmtTime(r.lastClick))}</td></tr>`);
    const countries = s.countries.map(r => `<tr><td>${escapeHtml(r.country)}</td><td class="num">${r.count}</td></tr>`);
    const referrers = s.referrers.map(r => `<tr><td class="wrap">${escapeHtml(r.referrer)}</td><td class="num">${r.count}</td></tr>`);
    const recent = s.recentClicks.map(c => `<tr><td>${escapeHtml(fmtTime(c.timestamp))}</td><td class="wrap">${escapeHtml(c.linkId)}</td><td>${escapeHtml(c.country)}</td><td class="wrap">${escapeHtml(c.referrer)}</td><td class="wrap">${escapeHtml(truncate(c.userAgent, 60))}</td><td>${escapeHtml(c.ip)}</td></tr>`);

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SwiftRoute Analytics</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--text:#1a1d21;--muted:#6b7280;--line:#e5e7eb;--accent:#2563eb}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#181b21;--text:#e8eaed;--muted:#9aa0a6;--line:#2a2e36;--accent:#60a5fa}}
*{box-sizing:border-box}
body{margin:0;padding:16px;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1100px;margin:0 auto}
h1{font-size:20px;margin:0 0 4px}
h2{font-size:15px;margin:0 0 10px}
.muted{color:var(--muted)}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));margin:12px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;min-width:0}
.big{font-size:28px;font-weight:600}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top;white-space:nowrap}
th{color:var(--muted);font-weight:500}
td.num{text-align:right;font-variant-numeric:tabular-nums}
td.wrap{white-space:normal;word-break:break-all;min-width:120px}
.chart{display:flex;align-items:flex-end;gap:2px;height:160px;padding-top:8px}
.bar{flex:1;height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;min-width:0}
.bar span{display:block;width:100%;background:var(--accent);border-radius:2px 2px 0 0;min-height:1px}
.bar small{font-size:9px;color:var(--muted);margin-top:2px}
</style>
</head>
<body>
<main>
<h1>SwiftRoute Analytics</h1>
<div class="muted">Generated ${escapeHtml(fmtTime(s.generatedAt))} UTC</div>
<div class="grid">
<div class="card"><div class="muted">Total clicks</div><div class="big">${s.totalClicks}</div></div>
<div class="card"><div class="muted">Last 24 hours</div><div class="big">${s.clicksLast24h}</div></div>
<div class="card"><div class="muted">Distinct links</div><div class="big">${s.distinctLinks}</div></div>
</div>
<div class="card"><h2>Clicks per day (last 30 days)</h2><div class="chart">${bars}</div></div>
<div class="grid">
<div class="card"><h2>Top countries</h2>${table(['Country', 'Clicks'], countries)}</div>
<div class="card"><h2>Top referrers</h2>${table(['Referrer', 'Clicks'], referrers)}</div>
</div>
<div class="card"><h2>Top links</h2>${table(['Link', 'Clicks', 'Last click (UTC)'], topLinks)}</div>
<div class="card" style="margin-top:12px"><h2>Recent clicks</h2>${table(['Time (UTC)', 'Link', 'Country', 'Referrer', 'User agent', 'IP'], recent)}</div>
</main>
</body>
</html>`;
};

const send = (res, status, type, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
    res.end(body);
};
const sendJson = (res, status, data, headers) => send(res, status, 'application/json', JSON.stringify(data), headers);

const handler = async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;

    if (path === '/health') {
        return sendJson(res, 200, { status: 'ok' });
    }

    if (path !== '/api/stats' && path !== '/dashboard') {
        return sendJson(res, 404, { error: 'Not found' });
    }

    if (!process.env.DASHBOARD_TOKEN) {
        return sendJson(res, 503, { error: 'DASHBOARD_TOKEN is not configured' });
    }

    if (!isAuthorized(req)) {
        return sendJson(res, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Basic realm="SwiftRoute Analytics", charset="UTF-8"' });
    }

    try {
        const stats = await getStats();
        if (path === '/api/stats') return sendJson(res, 200, stats);
        return send(res, 200, 'text/html; charset=utf-8', renderDashboard(stats));
    } catch (error) {
        console.error('Failed to load stats:', error.message);
        if (path === '/api/stats') return sendJson(res, 500, { error: 'Failed to load stats' });
        return send(res, 500, 'text/html; charset=utf-8', '<!doctype html><meta charset="utf-8"><title>Error</title><p>Failed to load stats.</p>');
    }
};

const startServer = () => {
    server = http.createServer((req, res) => {
        handler(req, res).catch(error => {
            console.error('Unhandled request error:', error.message);
            if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
            else res.end();
        });
    });
    server.listen(PORT, () => console.log(`HTTP server listening on ${PORT}`));
    return server;
};

const stopServer = () => new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
    server.closeAllConnections();
});

module.exports = { startServer, stopServer };
