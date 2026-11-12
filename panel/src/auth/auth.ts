import { HttpStatus, respond } from '@common';
import { SignJWT, jwtVerify } from 'jose';
import { getGlobals } from '@settings';
import { storeGet, storePut } from '@store';

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_PREFIX = 'pbkdf2$';
// Mirrors the frontend policy in assets/panel/script.js.
const PASSWORD_POLICY = /^(?=.*[A-Z])(?=.*\d).{8,}$/;

function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    bytes.forEach(byte => binary += String.fromCharCode(byte));
    return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }

    return bytes;
}

async function derivePasswordKey(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(password),
        'PBKDF2',
        false,
        ['deriveBits']
    );

    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
        keyMaterial,
        256
    );

    return new Uint8Array(bits);
}

async function hashPassword(password: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hash = await derivePasswordKey(password, salt, PBKDF2_ITERATIONS);

    return `${PBKDF2_PREFIX}${PBKDF2_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(hash)}`;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a[i] ^ b[i];
    }

    return diff === 0;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
    if (!stored.startsWith(PBKDF2_PREFIX)) {
        // Legacy plaintext record (pre-hashing installs).
        return password === stored;
    }

    const parts = stored.split('$');
    if (parts.length !== 4) return false;

    const iterations = parseInt(parts[1], 10);
    if (!Number.isFinite(iterations) || iterations < 1) return false;

    let salt: Uint8Array<ArrayBuffer>;
    let expected: Uint8Array;
    try {
        salt = base64ToBytes(parts[2]);
        expected = base64ToBytes(parts[3]);
    } catch {
        return false;
    }

    const actual = await derivePasswordKey(password, salt, iterations);
    return timingSafeEqual(actual, expected);
}

export function logout(): Response {
    return respond(true, HttpStatus.OK, 'Successfully logged out!', null, {
        'Set-Cookie': 'jwtToken=; Path=/; Secure; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
        'Content-Type': 'text/plain'
    });
}

export async function generateJWTToken(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
        return respond(false, HttpStatus.METHOD_NOT_ALLOWED, 'Method not allowed.');
    }

    const data = await request.json() as any;
    const savedPass = await storeGet(env, 'pwd');
    const { accEmail } = getGlobals();
    const username = data.username?.toLowerCase();
    const password = typeof data.password === 'string' ? data.password : '';

    if (!savedPass || username !== accEmail || !(await verifyPassword(password, savedPass))) {
        return respond(false, HttpStatus.UNAUTHORIZED, 'Wrong Credentials.');
    }

    // Migrate a legacy plaintext record to the hashed format on successful login.
    if (!savedPass.startsWith(PBKDF2_PREFIX)) {
        await storePut(env, 'pwd', await hashPassword(password));
    }

    let secretKey = await storeGet(env, 'secretKey');
    if (!secretKey) {
        secretKey = generateSecretKey();
        await storePut(env, 'secretKey', secretKey);

        const readBack = await storeGet(env, 'secretKey');
        if (readBack !== secretKey) {
            return respond(false, HttpStatus.INTERNAL_SERVER_ERROR, 'Failed to persist session secret.');
        }
    }

    const secret = new TextEncoder().encode(secretKey);
    const { accID } = getGlobals();
    const jwtToken = await new SignJWT({ id: accID })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('24h')
        .sign(secret);

    return respond(true, HttpStatus.OK, 'Successfully generated Auth token', null, {
        'Set-Cookie': `jwtToken=${jwtToken}; Path=/; HttpOnly; Secure; Max-Age=${24 * 60 * 60}; SameSite=Strict`,
        'Content-Type': 'text/plain',
    });
}

function generateSecretKey(): string {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);

    return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function authenticate(request: Request, env: Env): Promise<boolean> {
    // Storage errors intentionally propagate: they are server failures
    // (500-class), not credential mismatches.
    const secretKey = await storeGet(env, 'secretKey');
    if (secretKey === null) {
        console.log('Secret key not found in DB.');
        return false;
    }

    const cookie = request.headers.get('Cookie')?.match(/(^|;\s*)jwtToken=([^;]*)/);
    const token = cookie ? cookie[2] : null;
    if (!token) {
        console.log('Unauthorized: Token not available!');
        return false;
    }

    try {
        const secret = new TextEncoder().encode(secretKey);
        const { payload } = await jwtVerify(token, secret);
        console.log(`Successfully authenticated, User ID: ${payload.id}`);

        return true;
    } catch (error) {
        console.log(error);
        return false;
    }
}

export async function resetPassword(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
        return respond(false, HttpStatus.METHOD_NOT_ALLOWED, 'Method not allowed.');
    }

    const auth = await authenticate(request, env);
    const oldPwd = await storeGet(env, 'pwd');
    if (oldPwd && !auth) {
        return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized.');
    }

    const data = await request.json() as any;
    const { accEmail } = getGlobals();

    if (!auth && !data.username) {
        return respond(false, HttpStatus.BAD_REQUEST, 'Missing username.');
    }

    if (data.username && data.username !== accEmail) {
        return respond(false, HttpStatus.BAD_REQUEST, 'Wrong username.');
    }

    if (typeof data.password !== 'string' || !data.password) {
        return respond(false, HttpStatus.BAD_REQUEST, 'Missing password.');
    }

    if (!PASSWORD_POLICY.test(data.password)) {
        return respond(false, HttpStatus.BAD_REQUEST, 'Must contain at least one capital letter, one number, and be at least 8 characters long.');
    }

    if (oldPwd && (await verifyPassword(data.password, oldPwd))) {
        return respond(false, HttpStatus.BAD_REQUEST, 'Please enter a new Password.');
    }

    const hashed = await hashPassword(data.password);
    await storePut(env, 'pwd', hashed);

    const readBack = await storeGet(env, 'pwd');
    if (readBack !== hashed) {
        return respond(false, HttpStatus.INTERNAL_SERVER_ERROR, 'Failed to persist new password.');
    }

    // Rotate the JWT secret so previously issued sessions are invalidated.
    await storePut(env, 'secretKey', generateSecretKey());

    return respond(true, HttpStatus.OK, 'Successfully logged in!', null, {
        'Set-Cookie': 'jwtToken=; Path=/; Secure; SameSite=Strict; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
        'Content-Type': 'text/plain',
    });
}
