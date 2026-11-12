import { DnsHost, DbSettings, PanelSettings, TelegramBot, WarpAccount } from '#types/settings';
import { extractProxyParams, extractUpstreamParams, getDomain, resolveDNS } from '@utils';
import { fetchWarpAccounts } from '@api/warp';
import { safeError } from '@common';
import { getDbSettings } from '@settings';
import { setCustomDomain } from '@main';
import { storeGetJson, storePut } from '@store';

export async function getDataset(env: Env): Promise<{
    settings: DbSettings,
    telegramBot: TelegramBot,
    warpAccounts: WarpAccount[]
}> {
    let settings: DbSettings | null, warpAccounts: WarpAccount[] | null;
    const dbSettings = getDbSettings();

    try {
        settings = await storeGetJson(env, 'proxySettings');
        warpAccounts = await storeGetJson(env, 'warpAccounts');
        if (!settings) {
            await storePut(env, 'proxySettings', JSON.stringify(dbSettings));
            settings = dbSettings;
        }

        if (!warpAccounts) {
            warpAccounts = await fetchWarpAccounts(env);
        }

        if (VERSION !== settings.panelVersion) {
            settings = await updateDataset(env);
        }

        let telegramBot: TelegramBot | null = await storeGetJson(env, 'telegramBot');
        if (!telegramBot) {
            telegramBot = { telegramBotToken: '', telegramUserId: '' };
            await storePut(env, 'telegramBot', JSON.stringify(telegramBot));
        }

        return {
            settings,
            telegramBot,
            warpAccounts
        };
    } catch (error) {
        console.log(error);
        throw new Error(`An error occurred while getting DB: ${safeError(error)}`);
    }
}

export async function updateDataset(env: Env, newSettings?: PanelSettings): Promise<DbSettings> {
    if (!newSettings) {
        const dbSettings = getDbSettings();
        await storePut(env, 'proxySettings', JSON.stringify(dbSettings));
        return dbSettings;
    }

    let currentSettings: DbSettings | null;
    const dbSettings = getDbSettings();

    try {
        currentSettings = await storeGetJson(env, 'proxySettings');
    } catch (error) {
        console.log(error);
        throw new Error(`An error occurred while getting current DB settings: ${safeError(error)}`);
    }

    const getParam = async <T extends keyof DbSettings>(
        key: T,
        cbKey?: T,
        callback?: (value: DbSettings[T]) => any | Promise<any>
    ) => {
        const resolve = (k: T) => newSettings?.[k] ?? currentSettings?.[k] ?? dbSettings[k];

        if (callback && cbKey) {
            const cbValue = resolve(cbKey);
            if (cbValue !== currentSettings?.[cbKey]) {
                return callback(cbValue);
            }
        }

        const value = newSettings?.[key] ?? currentSettings?.[key] ?? dbSettings[key];
        return value;
    };

    const fields: Array<
        [keyof DbSettings] |
        [keyof DbSettings, keyof DbSettings, (key: any) => any | Promise<any>]
    > = [
            ['remoteDNS'],
            ['remoteDnsHost', 'remoteDNS', getDnsParams],
            ['localDNS'],
            ['antiSanctionDNS'],
            ['enableIPv6'],
            ['fakeDNS'],
            ['logLevel'],
            ['allowLANConnection'],
            ['customDomain', 'customDomain', setCustomDomain],
            ['upstreamProxy'],
            ['upstreamParams', 'upstreamProxy', extractUpstreamParams],
            ['chainProxy'],
            ['chainProxyParams', 'chainProxy', extractProxyParams],
            ['cleanIPs'],
            ['customCdnAddrs'],
            ['customCdnHost'],
            ['customCdnSni'],
            ['bestPingInterval'],
            ['protocols'],
            ['ports'],
            ['fingerprint'],
            ['enableTFO'],
            ['fragmentMode'],
            ['fragmentLengthMin'],
            ['fragmentLengthMax'],
            ['fragmentDelayMin'],
            ['fragmentDelayMax'],
            ['fragmentMaxSplitMin'],
            ['fragmentMaxSplitMax'],
            ['fragmentPackets'],
            ['enableECH'],
            ['echServerName'],
            ['bypassIran'],
            ['bypassChina'],
            ['bypassRussia'],
            ['bypassOpenAi'],
            ['bypassGoogleAi'],
            ['bypassMicrosoft'],
            ['bypassOracle'],
            ['bypassDocker'],
            ['bypassAdobe'],
            ['bypassEpicGames'],
            ['bypassIntel'],
            ['bypassAmd'],
            ['bypassNvidia'],
            ['bypassAsus'],
            ['bypassHp'],
            ['bypassLenovo'],
            ['blockAds'],
            ['blockPorn'],
            ['blockUDP443'],
            ['blockMalware'],
            ['blockPhishing'],
            ['blockCryptominers'],
            ['customBypassRules'],
            ['customBlockRules'],
            ['customBypassSanctionRules'],
            ['warpRemoteDNS'],
            ['warpEndpoints'],
            ['warpBestPingInterval'],
            ['warpReservedBytes'],
            ['xrayUdpNoises'],
            ['knockerNoiseMode'],
            ['knockerNoiseCountMin'],
            ['knockerNoiseCountMax'],
            ['knockerNoiseSizeMin'],
            ['knockerNoiseSizeMax'],
            ['knockerNoiseDelayMin'],
            ['knockerNoiseDelayMax'],
            ['amneziaNoiseCount'],
            ['amneziaNoiseSizeMin'],
            ['amneziaNoiseSizeMax'],
            ['customSubs'],
            ['remoteSettings'],
            ['customConfigs']
        ];

    try {
        const entries = await Promise.all(
            fields.map(async ([key, callbackKey, callbackFunc]) => {
                return [key, await getParam(key, callbackKey, callbackFunc)];
            })
        );

        const updatedSettings: DbSettings = {
            ...Object.fromEntries(entries),
            panelVersion: VERSION
        };

        await storePut(env, 'proxySettings', JSON.stringify(updatedSettings));
        return updatedSettings;
    } catch (error) {
        console.log(error);
        throw new Error(`An error occurred while updating DB: ${safeError(error)}`);
    }
}

async function getDnsParams(dns: string): Promise<DnsHost> {
    const { host, isHostDomain } = getDomain(dns);
    const dohHost: DnsHost = { host, isDomain: isHostDomain, ipv4: [], ipv6: [] };

    if (isHostDomain) {
        const { ipv4, ipv6 } = await resolveDNS(host);
        dohHost.ipv4 = ipv4;
        dohHost.ipv6 = ipv6;
    }

    return dohHost;
}