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

const fillDays = (daily) => {
    const byDay = new Map(daily.map(row => [row.day, Number(row.count)]));
    const perDay = [];
    for (let i = 29; i >= 0; i--) {
        const day = new Date(Date.now() - i * DAY_MS).toISOString().slice(0, 10);
        perDay.push({ day, count: byDay.get(day) || 0 });
    }
    return perDay;
};

const getStats = async () => {
    const since24h = new Date(Date.now() - DAY_MS);
    const since30d = new Date(Date.now() - 30 * DAY_MS);

    const [total, last24h, distinct, topLinks, countries, referrers, daily, recent, cities] = await Promise.all([
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
        prisma.click.findMany({ orderBy: { timestamp: 'desc' }, take: 50 }),
        prisma.click.groupBy({
            by: ['city', 'region', 'country'],
            where: { city: { not: null } },
            _count: { _all: true },
            orderBy: { _count: { city: 'desc' } },
            take: 15
        })
    ]);

    const perDay = fillDays(daily);

    return {
        generatedAt: new Date().toISOString(),
        totalClicks: total,
        clicksLast24h: last24h,
        distinctLinks: Number(distinct[0].count),
        topLinks: topLinks.map(r => ({ linkId: r.linkId, count: r._count._all, lastClick: r._max.timestamp })),
        countries: countries.map(r => ({ country: r.country || 'Unknown', count: r._count._all })),
        referrers: referrers.map(r => ({ referrer: r.referrer || 'Direct / none', count: r._count._all })),
        topCities: cities.map(r => ({ city: r.city, region: r.region, country: r.country, count: r._count._all })),
        clicksPerDay: perDay,
        recentClicks: recent.map(c => ({
            id: c.id,
            timestamp: c.timestamp,
            linkId: c.linkId,
            country: c.country,
            city: c.city,
            region: c.region,
            referrer: c.referrer,
            userAgent: c.userAgent,
            ip: c.ip
        }))
    };
};

const getLinkStats = async (linkId) => {
    const since30d = new Date(Date.now() - 30 * DAY_MS);
    const where = { linkId };

    const [agg, cities, countries, daily, clicks] = await Promise.all([
        prisma.click.aggregate({ where, _count: { _all: true }, _min: { timestamp: true }, _max: { timestamp: true } }),
        prisma.click.groupBy({
            by: ['city', 'region', 'country'],
            where: { linkId, city: { not: null } },
            _count: { _all: true },
            orderBy: { _count: { city: 'desc' } },
            take: 25
        }),
        prisma.click.groupBy({
            by: ['country'],
            where,
            _count: { _all: true },
            orderBy: { _count: { country: 'desc' } },
            take: 15
        }),
        prisma.$queryRaw`SELECT to_char(date_trunc('day', "timestamp"), 'YYYY-MM-DD') AS day, COUNT(*) AS count
            FROM "Click" WHERE "linkId" = ${linkId} AND "timestamp" >= ${since30d} GROUP BY 1 ORDER BY 1`,
        prisma.click.findMany({ where, orderBy: { timestamp: 'desc' }, take: 200 })
    ]);

    return {
        linkId,
        totalClicks: agg._count._all,
        firstClick: agg._min.timestamp,
        lastClick: agg._max.timestamp,
        cities: cities.map(r => ({ city: r.city, region: r.region, country: r.country, count: r._count._all })),
        countries: countries.map(r => ({ country: r.country || 'Unknown', count: r._count._all })),
        clicksPerDay: fillDays(daily),
        clicks
    };
};

const fmtTime = (d) => d ? new Date(d).toISOString().replace('T', ' ').slice(0, 19) : '';
const truncate = (s, n) => s && s.length > n ? s.slice(0, n) + '...' : (s || '');

const table = (headers, rows) => `<div class="scroll"><table><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${
    rows.length ? rows.join('') : `<tr><td colspan="${headers.length}" class="muted">No data</td></tr>`
}</tbody></table></div>`;

const STYLE = `<style>
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
.back{display:inline-block;margin-bottom:10px}
a{color:var(--accent)}
dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;margin:0}
dt{color:var(--muted)}
dd{margin:0;word-break:break-all}
iframe{width:100%;height:320px;border:1px solid var(--line);border-radius:6px}
</style>`;

const locationOf = (c) => [c.city, c.region, c.country].filter(Boolean).join(', ');
const linkHref = (id) => `/dashboard/link?id=${encodeURIComponent(id)}`;
const clickHref = (id) => `/dashboard/click/${encodeURIComponent(id)}`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const barChart = (perDay) => {
    const max = Math.max(1, ...perDay.map(d => d.count));
    return perDay.map(d =>
        `<div class="bar" title="${escapeHtml(d.day)}: ${d.count}"><span style="height:${Math.round(d.count / max * 100)}%"></span><small>${escapeHtml(d.day.slice(8))}</small></div>`
    ).join('');
};

const layout = (title, body) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${STYLE}
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;

const BACK = '<a class="back" href="/dashboard">&larr; Back to dashboard</a>';

const renderNotFound = (message) => layout('Not found', `${BACK}<div class="card"><h2>Not found</h2><p class="muted">${escapeHtml(message)}</p></div>`);

const renderLink = (l) => {
    const isHttp = /^https?:\/\//i.test(l.linkId);
    const linkText = isHttp
        ? `<a href="${escapeHtml(l.linkId)}" rel="noopener noreferrer nofollow">${escapeHtml(l.linkId)}</a>`
        : escapeHtml(l.linkId);
    const cities = l.cities.map(r => `<tr><td>${escapeHtml(r.city)}</td><td>${escapeHtml(r.region)}</td><td>${escapeHtml(r.country)}</td><td class="num">${r.count}</td></tr>`);
    const countries = l.countries.map(r => `<tr><td>${escapeHtml(r.country)}</td><td class="num">${r.count}</td></tr>`);
    const clicks = l.clicks.map(c => `<tr><td><a href="${clickHref(c.id)}">${escapeHtml(fmtTime(c.timestamp))}</a></td><td>${escapeHtml(locationOf(c))}</td><td class="num">${c.accuracyRadius == null ? '' : '&plusmn;' + Number(c.accuracyRadius) + ' km'}</td><td class="wrap">${escapeHtml(c.referrer)}</td><td class="wrap">${escapeHtml(truncate(c.userAgent, 60))}</td><td>${escapeHtml(c.ip)}</td></tr>`);

    return layout('Link analytics', `${BACK}
<h1>Link analytics</h1>
<div class="card" style="margin:12px 0"><div class="muted">Link</div><div style="word-break:break-all">${linkText}</div></div>
<div class="grid">
<div class="card"><div class="muted">Total clicks</div><div class="big">${l.totalClicks}</div></div>
<div class="card"><div class="muted">First click (UTC)</div><div>${escapeHtml(fmtTime(l.firstClick))}</div></div>
<div class="card"><div class="muted">Last click (UTC)</div><div>${escapeHtml(fmtTime(l.lastClick))}</div></div>
</div>
<div class="card"><h2>Clicks per day (last 30 days)</h2><div class="chart">${barChart(l.clicksPerDay)}</div></div>
<div class="grid">
<div class="card"><h2>Clicks by city</h2>${table(['City', 'Region', 'Country', 'Clicks'], cities)}</div>
<div class="card"><h2>Clicks by country</h2>${table(['Country', 'Clicks'], countries)}</div>
</div>
<div class="card" style="margin-top:12px"><h2>Latest clicks (up to 200)</h2>${table(['Time (UTC)', 'Location', 'Radius', 'Referrer', 'User agent', 'IP'], clicks)}</div>`);
};

const renderClick = (c) => {
    const lat = c.latitude == null ? null : Number(c.latitude);
    const lon = c.longitude == null ? null : Number(c.longitude);
    const hasCoords = Number.isFinite(lat) && Number.isFinite(lon);
    const row = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
    let coords = '';
    let map = '';
    if (hasCoords) {
        const d = 0.5;
        const bbox = [lon - d, lat - d, lon + d, lat + d].map(Number).join(',');
        const embed = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&amp;layer=mapnik&amp;marker=${lat},${lon}`;
        const full = `https://www.openstreetmap.org/?mlat=${lat}&amp;mlon=${lon}#map=10/${lat}/${lon}`;
        const radius = c.accuracyRadius == null ? '' : `, &plusmn;${Number(c.accuracyRadius)} km`;
        coords = `${lat}, ${lon} <span class="muted">(approximate${radius})</span>`;
        map = `<div class="card" style="margin-top:12px"><h2>Map</h2><iframe src="${embed}" loading="lazy" referrerpolicy="no-referrer"></iframe><p><a href="${full}" target="_blank" rel="noopener noreferrer">View larger map on OpenStreetMap</a></p></div>`;
    }
    return layout('Click detail', `${BACK}
<h1>Click detail</h1>
<div class="card" style="margin-top:12px"><dl>
${row('ID', escapeHtml(c.id))}
${row('Time (UTC)', escapeHtml(fmtTime(c.timestamp)))}
${row('Link', `<a href="${linkHref(c.linkId)}">${escapeHtml(c.linkId)}</a>`)}
${row('Location', escapeHtml(locationOf(c)) || '<span class="muted">Unknown</span>')}
${row('Country', escapeHtml(c.country))}
${hasCoords ? row('Coordinates', coords) : ''}
${row('Timezone', escapeHtml(c.timezone))}
${row('IP', escapeHtml(c.ip))}
${row('Referrer', escapeHtml(c.referrer))}
${row('User agent', escapeHtml(c.userAgent))}
</dl></div>${map}`);
};

const renderDashboard = (s) => {
    const bars = barChart(s.clicksPerDay);

    const topLinks = s.topLinks.map(r => `<tr><td class="wrap"><a href="${linkHref(r.linkId)}">${escapeHtml(r.linkId)}</a></td><td class="num">${r.count}</td><td>${escapeHtml(fmtTime(r.lastClick))}</td></tr>`);
    const countries = s.countries.map(r => `<tr><td>${escapeHtml(r.country)}</td><td class="num">${r.count}</td></tr>`);
    const referrers = s.referrers.map(r => `<tr><td class="wrap">${escapeHtml(r.referrer)}</td><td class="num">${r.count}</td></tr>`);
    const cities = s.topCities.map(r => `<tr><td>${escapeHtml(r.city)}</td><td>${escapeHtml(r.region)}</td><td>${escapeHtml(r.country)}</td><td class="num">${r.count}</td></tr>`);
    const recent = s.recentClicks.map(c => `<tr><td><a href="${clickHref(c.id)}">${escapeHtml(fmtTime(c.timestamp))}</a></td><td class="wrap">${escapeHtml(c.linkId)}</td><td>${escapeHtml(locationOf(c))}</td><td class="wrap">${escapeHtml(c.referrer)}</td><td class="wrap">${escapeHtml(truncate(c.userAgent, 60))}</td><td>${escapeHtml(c.ip)}</td></tr>`);

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SwiftRoute Analytics</title>
${STYLE}
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
<div class="card" style="margin-bottom:12px"><h2>Top cities</h2>${table(['City', 'Region', 'Country', 'Clicks'], cities)}</div>
<div class="card"><h2>Top links</h2>${table(['Link', 'Clicks', 'Last click (UTC)'], topLinks)}</div>
<div class="card" style="margin-top:12px"><h2>Recent clicks</h2>${table(['Time (UTC)', 'Link', 'Location', 'Referrer', 'User agent', 'IP'], recent)}</div>
</main>
</body>
</html>`;
};

const send = (res, status, type, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
    res.end(body);
};
const sendJson = (res, status, data, headers) => send(res, status, 'application/json', JSON.stringify(data), headers);

const sendHtml = (res, status, html) => send(res, status, 'text/html; charset=utf-8', html);

const handler = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    if (path === '/health') {
        return sendJson(res, 200, { status: 'ok' });
    }

    const isDashboard = path === '/dashboard' || path.startsWith('/dashboard/');
    if (path !== '/api/stats' && !isDashboard) {
        return sendJson(res, 404, { error: 'Not found' });
    }

    if (!process.env.DASHBOARD_TOKEN) {
        return sendJson(res, 503, { error: 'DASHBOARD_TOKEN is not configured' });
    }

    if (!isAuthorized(req)) {
        return sendJson(res, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Basic realm="SwiftRoute Analytics", charset="UTF-8"' });
    }

    // resolve route before touching the DB so bad paths/ids 404 cleanly
    let route = null;
    let param = null;
    if (path === '/api/stats') route = 'stats';
    else if (path === '/dashboard') route = 'dashboard';
    else if (path === '/dashboard/link') {
        param = url.searchParams.get('id');
        route = param ? 'link' : null;
    } else if (path.startsWith('/dashboard/click/')) {
        let id = path.slice('/dashboard/click/'.length);
        try { id = decodeURIComponent(id); } catch (e) { id = ''; }
        if (UUID_RE.test(id)) { route = 'click'; param = id.toLowerCase(); }
    }

    if (!route) {
        return sendHtml(res, 404, renderNotFound('Page not found.'));
    }

    try {
        if (route === 'stats' || route === 'dashboard') {
            const stats = await getStats();
            if (route === 'stats') return sendJson(res, 200, stats);
            return sendHtml(res, 200, renderDashboard(stats));
        }
        if (route === 'link') {
            const link = await getLinkStats(param);
            if (link.totalClicks === 0) return sendHtml(res, 404, renderNotFound('No clicks recorded for this link.'));
            return sendHtml(res, 200, renderLink(link));
        }
        const click = await prisma.click.findUnique({ where: { id: param } });
        if (!click) return sendHtml(res, 404, renderNotFound('Click not found.'));
        return sendHtml(res, 200, renderClick(click));
    } catch (error) {
        console.error('Failed to load dashboard data:', error.message);
        if (route === 'stats') return sendJson(res, 500, { error: 'Failed to load stats' });
        return sendHtml(res, 500, '<!doctype html><meta charset="utf-8"><title>Error</title><p>Failed to load data.</p>');
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
