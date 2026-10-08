const TIMEOUT_MS = 2000;
const HIT_TTL_MS = 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 60 * 60 * 1000;
const PAUSE_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 5000;

const cache = new Map();
let pausedUntil = 0;

const toStr = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

const isPrivateIp = (ip) => {
    if (typeof ip !== 'string' || ip.trim() === '') return true;
    const v = ip.trim().toLowerCase().replace(/^::ffff:/, '');
    const m = v.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
        const a = Number(m[1]);
        const b = Number(m[2]);
        return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
    }
    if (v === '::1' || v === '::') return true;
    // fc00::/7 -> fc/fd prefix, fe80::/10 -> fe8x-febx
    return /^f[cd][0-9a-f]{2}:/.test(v) || /^fe[89ab][0-9a-f]:/.test(v);
};

const setCache = (ip, value, ttl) => {
    cache.delete(ip);
    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(ip, { value, expires: Date.now() + ttl });
};

const parse = (body) => {
    if (!body || typeof body !== 'object' || body.bogon === true) return null;
    const city = toStr(body.city);
    let latitude = null;
    let longitude = null;
    if (typeof body.loc === 'string' && body.loc.includes(',')) {
        const [lat, lon] = body.loc.split(',');
        latitude = lat.trim() === '' ? null : Number(lat);
        longitude = lon.trim() === '' ? null : Number(lon);
        if (!Number.isFinite(latitude)) latitude = null;
        if (!Number.isFinite(longitude)) longitude = null;
    }
    // a Lite-only token returns country/ASN but no city or loc
    if (!city && latitude === null && longitude === null) return null;
    const org = toStr(body.org);
    return {
        city,
        region: toStr(body.region),
        country: toStr(body.country),
        latitude,
        longitude,
        postal: toStr(body.postal),
        timezone: toStr(body.timezone),
        isp: org ? toStr(org.replace(/^AS\d+\s+/i, '')) : null
    };
};

const lookupIp = async (ip) => {
    try {
        if (isPrivateIp(ip)) return null;
        const key = ip.trim();

        const hit = cache.get(key);
        if (hit && hit.expires > Date.now()) return hit.value;
        if (hit) cache.delete(key);

        if (Date.now() < pausedUntil) return null;

        const headers = { Accept: 'application/json' };
        if (process.env.IPINFO_TOKEN) headers.Authorization = `Bearer ${process.env.IPINFO_TOKEN}`;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        let res;
        try {
            res = await fetch(`https://ipinfo.io/${encodeURIComponent(key)}/json`, { headers, signal: controller.signal });
            if (res.status === 429 || res.status === 403) {
                pausedUntil = Date.now() + PAUSE_MS;
                console.warn(`ipinfo returned ${res.status}; pausing lookups for 10 minutes`);
                return null;
            }
            if (res.status !== 200) {
                setCache(key, null, MISS_TTL_MS);
                return null;
            }
            const value = parse(await res.json());
            setCache(key, value, value ? HIT_TTL_MS : MISS_TTL_MS);
            return value;
        } finally {
            clearTimeout(timer);
        }
    } catch (error) {
        // network errors, timeouts and bad JSON are not cached
        return null;
    }
};

module.exports = { lookupIp };
