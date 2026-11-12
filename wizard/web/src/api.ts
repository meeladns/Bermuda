import Cloudflare, { Uploadable } from 'cloudflare';
import { randSubdomain } from './random';

export class CFAccount {
    readonly token: string;
    readonly id: string;
    readonly email: string;
    readonly client: Cloudflare;

    private constructor(token: string, client: Cloudflare, id: string, email: string) {
        this.token = token;
        this.client = client;
        this.id = id;
        this.email = email;
    }

    static async create(token: string): Promise<CFAccount> {
        const client = new Cloudflare({ apiToken: token });

        const response = await client.user.tokens.verify();
        if (response.status !== 'active') {
            throw new Error(`API token is ${response.status}.`)
        }

        const [accounts, user] = await Promise.all([
            client.accounts.list(),
            client.user.get(),
        ]);

        return new CFAccount(token, client, accounts.result[0].id, user.email.toLowerCase());
    }

    async nameTaken(deployType: string, name: string): Promise<boolean> {
        try {
            if (deployType === "pages") {
                await this.client.pages.projects.get(name, {
                    account_id: this.id,
                });
            }

            await this.client.workers.scripts.get(name, {
                account_id: this.id,
            });

            return true;
        } catch (error) {
            return false;
        }
    }

    async createD1Database(workerName: string): Promise<string> {
        const listRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${this.id}/d1/database`, {
            headers: { 'Authorization': `Bearer ${this.token}` }
        });

        const listData = await listRes.json() as any;
        if (!listRes.ok || !listData.success) {
            throw new Error(`The API token cannot access D1 on account ${this.email}. It needs the D1 (Edit) permission — refresh this page, then create a fresh token from the "Create a token" link above and check that "D1 - Edit" appears in the token summary.`);
        }

        const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${this.id}/d1/database`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ name: workerName })
        });

        const data = await res.json() as any;
        if (!res.ok || !data.success) {
            throw new Error(`Error creating D1 database: ${JSON.stringify(data.errors, null, 2)} — the API token needs the D1 (Edit) permission.`)
        }

        const databaseId = data.result.uuid as string;
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(databaseId)) {
            throw new Error(`Error creating D1 database: Cloudflare returned an invalid database UUID.`)
        }

        const queryRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${this.id}/d1/database/${databaseId}/query`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                sql: 'CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, value TEXT NOT NULL)'
            })
        });

        const queryData = await queryRes.json() as any;
        if (!queryRes.ok || !queryData.success) {
            throw new Error(`Error initializing D1 database: ${JSON.stringify(queryData.errors, null, 2)}`)
        }

        const readRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${this.id}/d1/database/${databaseId}/query`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'store'"
            })
        });

        const readData = await readRes.json() as any;
        const tables = readData?.result?.[0]?.results ?? [];
        if (!readRes.ok || !readData.success || !tables.some((row: any) => row.name === 'store')) {
            throw new Error(`Error verifying D1 database: the store table could not be read back after initialization.`)
        }

        return databaseId;
    }

    async getWorkersDevSubdomain(): Promise<string> {
        const res = await this.client.workers.subdomains.get({
            account_id: this.id,
        });

        return `${res.subdomain}.workers.dev`;
    }

    async createWorkersDevSubdomain(): Promise<string> {
        const maxAttempts = 3;

        for (let i = 0; i < maxAttempts; i++) {
            try {
                const res = await this.client.workers.subdomains.update({
                    account_id: this.id,
                    subdomain: randSubdomain(),
                });

                return res.subdomain;
            } catch (err) {
                continue;
            }
        }

        throw new Error(`Failed to create a unique workers.dev subdomain after ${maxAttempts} attempts.`);
    }

    async deployWorker(name: string, script: Uploadable, databaseId: string) {
        // TS SDK has bugs for workers deployment - Uploading files
        const date = new Date().toISOString().split('T')[0];
        const metadata = {
            main_module: 'worker.js',
            compatibility_date: date,
            compatibility_flags: ['nodejs_compat'],
            bindings: [
                { type: 'd1', name: 'db', id: databaseId },
                { type: 'secret_text', name: 'CF_API_TOKEN', text: this.token },
                { type: 'plain_text', name: 'CF_ACCOUNT_ID', text: this.id }
            ]
        };

        const uploadForm = new FormData();
        uploadForm.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
        uploadForm.append('worker.js', script as File, 'worker.js');

        const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${this.id}/workers/scripts/${name}`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${this.token}` },
            body: uploadForm
        });

        const data = await res.json() as any;
        if (!res.ok || !data.success) {
            throw new Error(`Error deploying worker: ${JSON.stringify(data.errors, null, 2)}`)
        }

        // await this.client.workers.scripts.update(name, {
        //     account_id: this.id,
        //     metadata: {
        //         main_module: 'worker.js',
        //         compatibility_date: date,
        //         compatibility_flags: ['nodejs_compat'],
        //         bindings: [{
        //             name: 'db',
        //             id: databaseId,
        //             type: 'd1',
        //         }],
        //     },
        //     files: [uploadable]
        // });
    }

    async enableSubdomain(name: string) {
        await this.client.workers.scripts.subdomain.create(name, {
            account_id: this.id,
            enabled: true,
            previews_enabled: true,
        });
    }

    async createPagesProject(name: string, databaseId: string): Promise<string> {
        const date = new Date().toISOString().split('T')[0];

        const project = await this.client.pages.projects.create({
            account_id: this.id,
            name: name,
            production_branch: 'main',
            deployment_configs: {
                production: {
                    browsers: {},
                    compatibility_date: date,
                    compatibility_flags: ['nodejs_compat'],
                    env_vars: {
                        'CF_API_TOKEN': { type: 'secret_text', value: this.token },
                        'CF_ACCOUNT_ID': { type: 'plain_text', value: this.id }
                    },
                    d1_databases: {
                        'db': { id: databaseId }
                    }
                }
            }
        });

        return project.subdomain ?? '';
    }

    async verifyWorkerDeployment(name: string, databaseId: string) {
        const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${this.id}/workers/scripts/${name}/settings`, {
            headers: { 'Authorization': `Bearer ${this.token}` }
        });

        const data = await res.json() as any;
        if (!res.ok || !data.success) {
            throw new Error(`Error verifying deployment: could not read back the Worker settings.`)
        }

        const bindings = data.result?.bindings ?? [];
        const hasD1 = bindings.some((b: any) => b.type === 'd1' && b.name === 'db' && (b.id === databaseId || b.database_id === databaseId));
        const hasSecret = bindings.some((b: any) => b.type === 'secret_text' && b.name === 'CF_API_TOKEN');
        const hasAccountId = bindings.some((b: any) => b.type === 'plain_text' && b.name === 'CF_ACCOUNT_ID');
        if (!hasD1 || !hasSecret || !hasAccountId) {
            throw new Error(`Error verifying deployment: the deployed Worker is missing expected bindings (d1 "db", secret CF_API_TOKEN, plain CF_ACCOUNT_ID).`)
        }
    }

    async verifyPagesDeployment(name: string, databaseId: string) {
        let project: any;
        try {
            project = await this.client.pages.projects.get(name, {
                account_id: this.id,
            });
        } catch (error) {
            throw new Error(`Error verifying deployment: could not read back the Pages project.`)
        }

        const production = project?.deployment_configs?.production ?? {};
        const d1 = production?.d1_databases?.db;
        const envVars = production?.env_vars ?? {};
        if (!d1 || d1.id !== databaseId || !envVars.CF_API_TOKEN || !envVars.CF_ACCOUNT_ID) {
            throw new Error(`Error verifying deployment: the Pages project is missing expected bindings (d1 "db", secret CF_API_TOKEN, plain CF_ACCOUNT_ID).`)
        }
    }

    async deployPages(name: string, script: Uploadable) {
        await this.client.pages.projects.deployments.create(name, {
            account_id: this.id,
            branch: 'main',
            manifest: '{}',
            "_worker.js": script
        });
    }
}


