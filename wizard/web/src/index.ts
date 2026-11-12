import { CFAccount } from "./api";
import { decrypt, encrypt } from "./encryption";
import { randSubdomain } from "./random";
import { buildScript } from "./script";
import { createStreamLogger, StreamLogger } from "./logger";

interface Env {
    SECRET: string;
    ASSETS: any;
}

export default {
    async fetch(request: Request, env: Env) {
        const url = new URL(request.url);

        if (url.pathname === '/api/deploy' && request.method === 'POST') {
            const origin = request.headers.get('Origin');
            if (origin !== url.origin) {
                return new Response('Unauthorized context', { status: 403 });
            }

            const logger = createStreamLogger();
            const { readable, success, info, error, close } = logger;

            (async () => {
                try {
                    const key = url.searchParams.get('key');
                    const preRelease = url.searchParams.get('pre-release') === 'true';
                    const formData = await request.formData();
                    const apiToken = key ? await decrypt(key, env.SECRET) : formData.get('apiToken')?.toString().trim() ?? '';
                    const deployType = formData.get('deployType')?.toString() || 'workers';
                    const account = await CFAccount.create(apiToken);

                    let workerName: string;
                    do {
                        workerName = randSubdomain();
                    } while (await account.nameTaken(deployType, workerName));

                    info('Installing Bermuda Panel...');
                    const databaseId = await account.createD1Database(workerName);
                    success('D1 database created successfully!');

                    if (deployType === 'pages') {
                        await deployPages(env, account, workerName, databaseId, logger, preRelease);
                    } else {
                        await deployWorkers(env, account, workerName, databaseId, logger, preRelease);
                    }
                } catch (err) {
                    error(`Failed to install Bermuda Panel: ${err}`);
                } finally {
                    close();
                }
            })();

            return new Response(readable, {
                headers: {
                    'Content-Type': 'application/x-ndjson'
                }
            });
        }

        if (url.pathname === '/') {
            return env.ASSETS.fetch(new URL('/index.html', request.url));
        }

        return env.ASSETS.fetch(request);
    }
};

async function deployPages(
    env: Env,
    account: CFAccount,
    workerName: string,
    databaseId: string,
    logger: StreamLogger,
    preRelease: boolean,
) {
    const { success, complete } = logger;

    const { script, path } = await buildScript(account, workerName, 'pages.dev', '_worker.js', preRelease);
    success('Script built successfully!');

    const subdomain = await account.createPagesProject(workerName, databaseId);
    success('Pages project created successfully!');

    await account.deployPages(workerName, script);
    success('Pages deployed successfully!');

    await account.verifyPagesDeployment(workerName, databaseId);
    success('Deployment verified successfully!');

    const url = new URL(`https://${subdomain}/${path}/panel`);
    const payload = {
        url: url.href,
        user: account.email,
        key: await encrypt(account.token, env.SECRET)
    }

    complete(JSON.stringify(payload));
}

async function deployWorkers(
    env: Env,
    account: CFAccount,
    workerName: string,
    databaseId: string,
    logger: StreamLogger,
    preRelease: boolean
) {
    const { success, complete } = logger;
    let subdomain: string;
    try {
        subdomain = await account.getWorkersDevSubdomain();
        success('Account workers subdomain is available!');
    } catch (error) {
        subdomain = await account.createWorkersDevSubdomain();
        success('Fresh account, Workers subdomain created successfully!');
    }

    const { script, path } = await buildScript(account, workerName, subdomain, 'worker.js', preRelease);
    success('Script built successfully!');

    await account.deployWorker(workerName, script, databaseId);
    success('Worker deployed successfully!');

    await account.enableSubdomain(workerName);
    success('Worker subdomain enabled successfully!');

    await account.verifyWorkerDeployment(workerName, databaseId);
    success('Deployment verified successfully!');

    const url = new URL(`https://${workerName}.${subdomain}/${path}/panel`);
    const payload = {
        url: url.href,
        user: account.email,
        key: await encrypt(account.token, env.SECRET)
    }

    complete(JSON.stringify(payload));
}