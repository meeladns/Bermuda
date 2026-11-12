import { decompressGzipBase64, safeError } from '@common';

export async function renderError(error: any): Promise<Response> {
    console.error(safeError(error));

    try {
        const str = await decompressGzipBase64(ERROR_HTML_CONTENT);
        const html = str
            .replace('__ERROR_MESSAGE__', safeError(error))
            .replaceAll('__ICON__', ICON_CONTENT);

        return new Response(html, {
            status: 500,
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
    } catch {
        return new Response('Internal Server Error', {
            status: 500,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
    }
}