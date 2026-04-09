import HLS from "hls-parser";

import { env, genericUserAgent } from "../../config.js";

const API_BASE = "https://nvapi.nicovideo.jp";
const BASE_URL = "https://www.nicovideo.jp";

const FRONTEND_HEADERS = {
    "X-Frontend-ID": "6",
    "X-Frontend-Version": "0",
    "User-Agent": genericUserAgent,
};

const WATCH_HEADERS = {
    ...FRONTEND_HEADERS,
    Accept: "application/json",
    "Accept-Language": "ja-JP,ja;q=0.9,en;q=0.8",
};

const WATCH_HEADERS_FALLBACK = {
    ...FRONTEND_HEADERS,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "ja-JP,ja;q=0.9,en;q=0.8",
    Origin: BASE_URL,
    Referer: `${BASE_URL}/`,
};

const HLS_HEADERS = {
    ...FRONTEND_HEADERS,
    Accept: "application/json;charset=utf-8",
    "Content-Type": "application/json",
    Origin: BASE_URL,
    Referer: `${BASE_URL}/`,
    "X-Request-With": BASE_URL,
};

const MANIFEST_HEADERS = {
    "User-Agent": genericUserAgent,
    Accept: "application/vnd.apple.mpegurl, application/x-mpegURL, */*",
    "Accept-Encoding": "identity",
    Origin: BASE_URL,
    Referer: `${BASE_URL}/`,
};

const debugEnabled = process.env.NICOVIDEO_DEBUG === "1";
const logDebug = (...args) => {
    if (debugEnabled) {
        console.log("[nicovideo]", ...args);
    }
};

const buildActionTrackId = () => `AAAAAAAAAA_${Date.now()}`;

const decodeHtmlEntities = (value) => value
    .replaceAll("&quot;", '"')
    .replaceAll("&#34;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

const looksLikeApiData = (value) => {
    if (!value || typeof value !== "object") {
        return false;
    }

    return "video" in value || "media" in value || "client" in value;
};

const pickApiData = (value) => {
    if (looksLikeApiData(value)) return value;
    if (looksLikeApiData(value?.apiData)) return value.apiData;
    if (looksLikeApiData(value?.data)) return value.data;
    if (looksLikeApiData(value?.props?.pageProps?.apiData)) return value.props.pageProps.apiData;
    if (looksLikeApiData(value?.props?.pageProps?.watchData?.apiData)) return value.props.pageProps.watchData.apiData;
    if (looksLikeApiData(value?.pageProps?.watchData?.apiData)) return value.pageProps.watchData.apiData;
    if (looksLikeApiData(value?.watch?.apiData)) return value.watch.apiData;
    return null;
};

const extractCookieHeader = (setCookies) => {
    const cookieList = Array.isArray(setCookies)
        ? setCookies
        : (setCookies ? [setCookies] : []);

    const cookiePairs = cookieList
        .map(entry => entry.split(";")[0]?.trim())
        .filter(Boolean);

    return cookiePairs.length ? cookiePairs.join("; ") : null;
};

const mergeCookieHeaders = (left, right) => {
    if (left && right) {
        return `${left}; ${right}`;
    }

    return left || right || null;
};

const extractApiDataFromHtml = (html) => {
    const attrMatch = html.match(/data-api-data=("|')(.*?)(\1)/s);
    if (attrMatch?.[2]) {
        try {
            const parsed = JSON.parse(decodeHtmlEntities(attrMatch[2]));
            return pickApiData(parsed);
        } catch {
            return null;
        }
    }

    const dataPropsMatch = html.match(/id=("|')js-initial-watch-data\1[^>]*\bdata-props=("|')(.*?)(\2)/s);
    if (dataPropsMatch?.[3]) {
        try {
            const parsed = JSON.parse(decodeHtmlEntities(dataPropsMatch[3]));
            return pickApiData(parsed);
        } catch {
            return null;
        }
    }

    const scriptMatch = html.match(/<script[^>]*id=("|')js-initial-watch-data\1[^>]*>(.*?)<\/script>/s);
    if (scriptMatch?.[2]) {
        const scriptText = scriptMatch[2].trim();
        if (!scriptText) {
            return null;
        }

        try {
            const parsed = JSON.parse(scriptText);
            return pickApiData(parsed);
        } catch {
            return null;
        }
    }

    return null;
};

const fetchWatchDataFromHtml = async ({ id, dispatcher }) => {
    const html = await fetch(`${BASE_URL}/watch/${id}`, {
        headers: {
            "User-Agent": genericUserAgent,
            Accept: "text/html",
            "Accept-Language": "ja-JP,ja;q=0.9,en;q=0.8",
            Origin: BASE_URL,
            Referer: `${BASE_URL}/`,
        },
        dispatcher,
    })
    .then(response => response.text())
    .catch(() => null);

    if (!html) {
        logDebug("html fallback fetch failed", { id });
        return null;
    }

    const apiData = extractApiDataFromHtml(html);
    if (!apiData) {
        logDebug("html fallback missing api data", {
            id,
            hasInitialWatchData: html.includes("js-initial-watch-data"),
            title: (html.match(/<title>(.*?)<\/title>/i) || [])[1],
        });
        return null;
    }

    return {
        meta: { status: 200 },
        data: apiData,
    };
};

const shouldTryHtmlFallback = (response) => {
    const errorCode = response?.meta?.errorCode?.toUpperCase();
    return !response?.meta || errorCode === "INVALID_PARAMETER" || errorCode === "NOT_FOUND";
};

const fetchJsonWithStatus = async (url, options = {}, debugLabel) => {
    try {
        const response = await fetch(url, options);
        const text = await response.text();
        const setCookies = typeof response.headers.getSetCookie === "function"
            ? response.headers.getSetCookie()
            : response.headers.get("set-cookie");

        try {
            return { json: JSON.parse(text), status: response.status, setCookies };
        } catch {
            if (debugEnabled) {
                logDebug("non-json response", {
                    label: debugLabel,
                    status: response.status,
                    contentType: response.headers.get("content-type"),
                    preview: text.slice(0, 200),
                });
            }
            return { json: null, status: response.status, setCookies };
        }
    } catch {
        return { json: null, status: null, setCookies: null };
    }
};

const fetchWatchData = async ({ id, actionTrackId, dispatcher }) => {
    const endpoints = [
        new URL(`${BASE_URL}/api/watch/v3_guest/${id}`),
        new URL(`${API_BASE}/v1/watch/${id}`),
    ];

    let lastResponse = null;
    let lastSource = null;
    let cookieHeader = null;

    for (const endpoint of endpoints) {
        endpoint.searchParams.set("actionTrackId", actionTrackId);

        let { json: response, status, setCookies } = await fetchJsonWithStatus(endpoint, {
            headers: WATCH_HEADERS,
            dispatcher,
        }, "watch");

        const watchCookies = extractCookieHeader(setCookies);
        cookieHeader = mergeCookieHeaders(cookieHeader, watchCookies);

        if (!response && status === 406) {
            ({ json: response, status, setCookies } = await fetchJsonWithStatus(endpoint, {
                headers: WATCH_HEADERS_FALLBACK,
                dispatcher,
            }, "watch-fallback"));

            const fallbackCookies = extractCookieHeader(setCookies);
            cookieHeader = mergeCookieHeaders(cookieHeader, fallbackCookies);
        }

        if (response?.meta) {
            lastResponse = response;
            lastSource = endpoint.toString();

            if (response.meta.status === 200) {
                return { response, source: lastSource, cookieHeader };
            }
        }
    }

    if (shouldTryHtmlFallback(lastResponse)) {
        const htmlFallback = await fetchWatchDataFromHtml({ id, dispatcher });
        if (htmlFallback) {
            return { response: htmlFallback, source: "html", cookieHeader };
        }
    }

    return { response: lastResponse, source: lastSource, cookieHeader };
};

const fetchJson = async (url, options = {}, debugLabel) => {
    const { json } = await fetchJsonWithStatus(url, options, debugLabel);
    return json;
};

const mapApiError = (meta, data) => {
    const errorCode = meta?.errorCode?.toUpperCase();
    const reasonCode = data?.reasonCode;

    switch (reasonCode) {
        case "DOMESTIC_VIDEO":
        case "HIGH_RISK_COUNTRY_VIDEO":
            return "content.video.region";
        case "HARMFUL_VIDEO":
            return "content.video.age";
        case "HIDDEN_VIDEO":
        case "CHANNEL_MEMBER_ONLY":
        case "PPV_VIDEO":
        case "PREMIUM_ONLY":
            return "content.video.private";
    }

    switch (errorCode) {
        case "NOT_FOUND":
        case "INVALID_PARAMETER":
            return "content.video.unavailable";
        case "FORBIDDEN":
            return "content.video.private";
        case "MAINTENANCE":
            return "fetch.fail";
    }

    return "fetch.fail";
};

const pickVariant = (variants, requestedQuality) => {
    if (!variants.length) {
        return null;
    }

    const sorted = variants
        .filter(variant => variant?.uri)
        .sort((a, b) => Number(b.bandwidth) - Number(a.bandwidth));

    if (!sorted.length) {
        return null;
    }

    if (!requestedQuality || !Number.isFinite(requestedQuality)) {
        return sorted[0];
    }

    const withResolution = sorted.filter(variant => variant?.resolution?.height);
    if (!withResolution.length) {
        return sorted[0];
    }

    return withResolution.reduce((prev, next) => {
        const prevDelta = Math.abs(prev.resolution.height - requestedQuality);
        const nextDelta = Math.abs(next.resolution.height - requestedQuality);
        return prevDelta <= nextDelta ? prev : next;
    });
};

const pickAudioTrack = (audioTracks) => {
    if (!audioTracks?.length) {
        return null;
    }

    return audioTracks.find(track => track.default)
        || audioTracks.find(track => track.autoselect)
        || audioTracks[0];
};

export default async function({ id, quality, isAudioOnly, isAudioMuted, dispatcher }) {
    const actionTrackId = buildActionTrackId();
    const { response: apiResp, source: watchSource, cookieHeader: watchCookieHeader } = await fetchWatchData({
        id,
        actionTrackId,
        dispatcher,
    });

    if (!apiResp?.meta) {
        logDebug("watch meta missing", { id, source: watchSource });
        return { error: "fetch.fail" };
    }

    if (apiResp.meta.status !== 200) {
        logDebug("watch error", {
            id,
            source: watchSource,
            status: apiResp.meta.status,
            errorCode: apiResp.meta.errorCode,
            reasonCode: apiResp.data?.reasonCode,
        });
        return { error: mapApiError(apiResp.meta, apiResp.data) };
    }

    const data = apiResp.data;
    if (!data) {
        logDebug("watch data missing", { id, source: watchSource });
        return { error: "fetch.empty" };
    }

    if (data.video?.duration > env.durationLimit) {
        return { error: "content.too_long" };
    }

    const domand = data.media?.domand;
    if (!domand) {
        const payment = data.payment?.video;
        logDebug("domand missing", {
            id,
            source: watchSource,
            hasPayment: Boolean(payment),
            paymentFlags: payment
                ? {
                    isAdmission: payment.isAdmission,
                    isPremium: payment.isPremium,
                    isPpv: payment.isPpv,
                    isContinuationBenefit: payment.isContinuationBenefit,
                }
                : null,
        });
        if (payment?.isAdmission || payment?.isPremium || payment?.isPpv || payment?.isContinuationBenefit) {
            return { error: "content.video.private" };
        }
        return { error: "fetch.empty" };
    }
    const videos = (domand?.videos ?? []).filter(video => video?.isAvailable && video?.id);
    const audios = (domand?.audios ?? []).filter(audio => audio?.isAvailable && audio?.id);
    const accessKey = domand?.accessRightKey;
    const trackId = data.client?.watchTrackId;

    if (!videos.length || !audios.length || !accessKey || !trackId) {
        logDebug("watch fields missing", {
            id,
            source: watchSource,
            hasVideos: videos.length > 0,
            hasAudios: audios.length > 0,
            hasAccessKey: Boolean(accessKey),
            hasTrackId: Boolean(trackId),
        });
        return { error: "fetch.empty" };
    }

    const outputs = [];
    for (const video of videos) {
        for (const audio of audios) {
            outputs.push([video.id, audio.id]);
        }
    }

    const { json: hlsResp, setCookies: hlsSetCookies } = await fetchJsonWithStatus(
        `${API_BASE}/v1/watch/${id}/access-rights/hls?actionTrackId=${encodeURIComponent(trackId)}`,
        {
            method: "POST",
            headers: {
                ...HLS_HEADERS,
                "X-Access-Right-Key": accessKey,
                ...(watchCookieHeader ? { Cookie: watchCookieHeader } : {}),
            },
            body: JSON.stringify({ outputs }),
            dispatcher,
        },
        "access-rights"
    );

    let hlsCookieHeader = mergeCookieHeaders(
        watchCookieHeader,
        extractCookieHeader(hlsSetCookies)
    );

    const contentUrl = hlsResp?.data?.contentUrl;
    if (!contentUrl) {
        logDebug("hls contentUrl missing", {
            id,
            status: hlsResp?.meta?.status,
            errorCode: hlsResp?.meta?.errorCode,
            reasonCode: hlsResp?.data?.reasonCode,
        });
        return { error: "fetch.empty" };
    }

    const manifestResponse = await fetch(contentUrl, {
        headers: {
            ...MANIFEST_HEADERS,
            ...(hlsCookieHeader ? { Cookie: hlsCookieHeader } : {}),
        },
        dispatcher,
    }).catch(() => null);

    const manifest = await manifestResponse?.text().catch(() => {});
    const manifestCookies = manifestResponse
        ? extractCookieHeader(
            typeof manifestResponse.headers.getSetCookie === "function"
                ? manifestResponse.headers.getSetCookie()
                : manifestResponse.headers.get("set-cookie")
        )
        : null;

    hlsCookieHeader = mergeCookieHeaders(hlsCookieHeader, manifestCookies);

    if (!manifest) {
        logDebug("manifest missing", { id });
        return { error: "fetch.fail" };
    }

    const normalizedManifest = manifest.replace(/^\ufeff/, "").trimStart();
    if (!normalizedManifest.startsWith("#EXTM3U")) {
        logDebug("manifest not m3u8", {
            id,
            preview: normalizedManifest.slice(0, 200),
        });
        return { error: "fetch.fail" };
    }

    const parsed = HLS.parse(normalizedManifest);
    const variants = parsed?.variants ?? [];
    if (!variants.length) {
        return { error: "fetch.empty" };
    }

    const requestedQuality = quality === "max" ? null : Number(quality);
    const bestVariant = pickVariant(variants, requestedQuality);
    if (!bestVariant) {
        return { error: "fetch.empty" };
    }

    const expandLink = (path) => new URL(path, contentUrl).toString();
    const videoUrl = expandLink(bestVariant.uri);
    const audioTrack = pickAudioTrack(bestVariant.audio);
    const audioUrl = audioTrack?.uri ? expandLink(audioTrack.uri) : null;

    let urls;
    if (isAudioOnly) {
        if (!audioUrl) {
            return { error: "fetch.empty" };
        }
        urls = audioUrl;
    } else if (isAudioMuted || !audioUrl) {
        urls = videoUrl;
    } else {
        urls = [videoUrl, audioUrl];
    }

    const title = data.video?.title?.trim();
    const owner = data.owner || data.channel;
    const author = owner?.name?.trim() || owner?.nickname?.trim();

    const filenameAttributes = {
        service: "nicovideo",
        id,
        title,
        author,
        extension: "mp4",
    };

    if (bestVariant.resolution?.width && bestVariant.resolution?.height) {
        filenameAttributes.resolution = `${bestVariant.resolution.width}x${bestVariant.resolution.height}`;
        filenameAttributes.qualityLabel = `${bestVariant.resolution.height}p`;
    }

    const fileMetadata = {
        title,
        artist: author,
    };

    const streamHeaders = {
        Referer: `${BASE_URL}/`,
        Origin: BASE_URL,
        "User-Agent": genericUserAgent,
        Accept: MANIFEST_HEADERS.Accept,
        "Accept-Language": "ja-JP,ja;q=0.9,en;q=0.8",
        "Accept-Encoding": "identity",
        ...(hlsCookieHeader ? { Cookie: hlsCookieHeader } : {}),
    };

    console.log(urls)
    return {
        urls,
        isHLS: true,
        headers: streamHeaders,
        filenameAttributes,
        fileMetadata,
    };
}
