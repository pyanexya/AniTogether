/** Routes API fetches through Rust instead of weakening WebView CORS security. */
export function installNativeFetch(target) {
    const original = target.fetch.bind(target);
    target.fetch = async (input, init = {}) => {
        const url = typeof input === 'string' ? input : input?.url || String(input);
        if (target.mediaTransport?.isLocalUrl(url) || !/^https?:\/\//i.test(url) || /^https?:\/\/(?:offline|asset|tauri)\.localhost(?:[/:]|$)/i.test(url)) return original(input, init);
        const signal = init.signal || input?.signal;
        const abortError = () => signal?.reason || new DOMException('Запрос отменён', 'AbortError');
        if (signal?.aborted) throw abortError();
        const headers = new Headers(init.headers || input?.headers || {});
        let body = init.body;
        if (body === undefined && typeof Request !== 'undefined' && input instanceof Request && !['GET', 'HEAD'].includes(input.method)) body = await input.clone().arrayBuffer();
        if (body instanceof URLSearchParams) {
            if (!headers.has('content-type')) headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8');
            body = body.toString();
        }
        if (typeof FormData !== 'undefined' && body instanceof FormData) {
            const encoded = new Response(body);
            if (!headers.has('content-type')) headers.set('content-type', encoded.headers.get('content-type'));
            body = await encoded.arrayBuffer();
        }
        if (typeof Blob !== 'undefined' && body instanceof Blob) body = await body.arrayBuffer();
        const requestInfo = { method: init.method || input?.method || 'GET', headers: Object.fromEntries(headers) };
        const redirect = init.redirect || input?.redirect;
        if (redirect) requestInfo.redirect = redirect;
        if (body != null) {
            if (typeof body === 'string') requestInfo.body = body;
            else if (body instanceof ArrayBuffer) requestInfo.bodyBytes = Array.from(new Uint8Array(body));
            else if (ArrayBuffer.isView(body)) requestInfo.bodyBytes = Array.from(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
            else throw new TypeError('Этот тип тела HTTP-запроса не поддерживается нативным мостом');
        }
        let abortListener;
        const aborted = new Promise((_, reject) => {
            abortListener = () => reject(abortError());
            signal?.addEventListener('abort', abortListener, { once: true });
            if (signal?.aborted) abortListener();
        });
        try {
            const result = await Promise.race([target.netElec.fetch(url, requestInfo), aborted]);
            const response = new Response([101, 204, 205, 304].includes(result.status) ? null : result.text, {
                status: result.status, statusText: result.statusText || '', headers: result.headers,
            });
            Object.defineProperty(response, 'url', { value: url });
            return response;
        } finally { signal?.removeEventListener('abort', abortListener); }
    };
    return () => { target.fetch = original; };
}
