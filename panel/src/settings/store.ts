// Minimal key/value store backed by a Cloudflare D1 table named "store".
// It replaces the KV namespace the panel used before: same keys, same JSON
// string values, but with D1's consistency and free-tier write headroom.

let tableReady: Promise<void> | null = null;

function ensureStoreTable(env: Env): Promise<void> {
    if (!tableReady) {
        tableReady = env.db.prepare(
            'CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, value TEXT NOT NULL)'
        ).run().then(
            () => undefined,
            (error) => {
                tableReady = null;
                throw error;
            }
        );
    }

    return tableReady;
}

export async function storeGet(env: Env, key: string): Promise<string | null> {
    await ensureStoreTable(env);
    const row = await env.db
        .prepare('SELECT value FROM store WHERE key = ?')
        .bind(key)
        .first<{ value: string }>();

    return row?.value ?? null;
}

export async function storeGetJson<T>(env: Env, key: string): Promise<T | null> {
    const raw = await storeGet(env, key);
    return raw ? (JSON.parse(raw) as T) : null;
}

export async function storePut(env: Env, key: string, value: string): Promise<void> {
    await ensureStoreTable(env);
    await env.db.prepare(
        'INSERT INTO store (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).bind(key, value).run();
}
