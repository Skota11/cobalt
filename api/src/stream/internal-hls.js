import HLS from "hls-parser";
import { createInternalStream } from "./manage.js";
import { request } from "undici";

function getURL(url) {
    try {
        return new URL(url);
    } catch {
        return null;
    }
}

function toInternalUri(uri, streamInfo) {
    const parsed = getURL(uri);
    if (parsed) {
        if (parsed.hostname === '127.0.0.1') {
            return uri;
        }
        return createInternalStream(uri, streamInfo);
    }

    const resolved = new URL(uri, streamInfo.url).toString();
    return createInternalStream(resolved, streamInfo);
}

function rewriteUriAttributes(line, streamInfo) {
    return line.replace(/URI=("[^"]*"|'[^']*'|[^,\s]+)/g, (match) => {
        const rawValue = match.slice(4);
        const quote = rawValue[0];
        let uri = rawValue;
        let wrap = "";

        if (quote === '"' || quote === "'") {
            uri = rawValue.slice(1, -1);
            wrap = quote;
        }

        const internalUri = toInternalUri(uri, streamInfo);
        return `URI=${wrap}${internalUri}${wrap}`;
    });
}

function rewritePlaylist(rawPlaylist, streamInfo) {
    const lines = rawPlaylist.split(/\r?\n/);
    const rewritten = lines.map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return line;

        if (!trimmed.startsWith('#')) {
            return toInternalUri(trimmed, streamInfo);
        }

        if (trimmed.startsWith('#EXT-X-KEY')
            || trimmed.startsWith('#EXT-X-MAP')
            || trimmed.startsWith('#EXT-X-MEDIA')
            || trimmed.startsWith('#EXT-X-I-FRAME-STREAM-INF')
            || trimmed.startsWith('#EXT-X-SESSION-KEY')) {
            return rewriteUriAttributes(line, streamInfo);
        }

        return line;
    });

    return rewritten.join('\n');
}

function transformObject(streamInfo, hlsObject) {
    if (hlsObject === undefined) {
        return (object) => transformObject(streamInfo, object);
    }

    let fullUrl;
    let rawUrl;
    const absoluteUrl = getURL(hlsObject.uri);
    if (absoluteUrl) {
        fullUrl = absoluteUrl;
        rawUrl = hlsObject.uri;
    } else {
        fullUrl = new URL(hlsObject.uri, streamInfo.url);
        rawUrl = fullUrl.toString();
    }

    if (fullUrl.hostname !== '127.0.0.1') {
        hlsObject.uri = createInternalStream(rawUrl, streamInfo);

        if (hlsObject.map) {
            hlsObject.map = transformObject(streamInfo, hlsObject.map);
        }
    }

    if (hlsObject.key?.uri) {
        hlsObject.key = transformObject(streamInfo, hlsObject.key);
    }

    if (Array.isArray(hlsObject.keys)) {
        hlsObject.keys = hlsObject.keys.map(transformObject(streamInfo));
    }

    return hlsObject;
}

function transformMasterPlaylist(streamInfo, hlsPlaylist) {
    const makeInternalStream = transformObject(streamInfo);

    const makeInternalVariants = (variant) => {
        variant = transformObject(streamInfo, variant);
        variant.video = variant.video.map(makeInternalStream);
        variant.audio = variant.audio.map(makeInternalStream);
        return variant;
    };
    hlsPlaylist.variants = hlsPlaylist.variants.map(makeInternalVariants);

    if (hlsPlaylist.key?.uri) {
        hlsPlaylist.key = transformObject(streamInfo, hlsPlaylist.key);
    }

    if (Array.isArray(hlsPlaylist.keys)) {
        hlsPlaylist.keys = hlsPlaylist.keys.map(makeInternalStream);
    }

    return hlsPlaylist;
}

function transformMediaPlaylist(streamInfo, hlsPlaylist) {
    const makeInternalSegments = transformObject(streamInfo);
    hlsPlaylist.segments = hlsPlaylist.segments.map(makeInternalSegments);
    hlsPlaylist.prefetchSegments = hlsPlaylist.prefetchSegments.map(makeInternalSegments);

    if (hlsPlaylist.key?.uri) {
        hlsPlaylist.key = transformObject(streamInfo, hlsPlaylist.key);
    }

    if (Array.isArray(hlsPlaylist.keys)) {
        hlsPlaylist.keys = hlsPlaylist.keys.map(makeInternalSegments);
    }
    return hlsPlaylist;
}

const HLS_MIME_TYPES = ["application/vnd.apple.mpegurl", "audio/mpegurl", "application/x-mpegURL"];

export function isHlsResponse(req, streamInfo) {
    return HLS_MIME_TYPES.includes(req.headers['content-type'])
        // bluesky's cdn responds with wrong content-type for the hls playlist,
        // so we enforce it here until they fix it
        || (streamInfo.service === 'bsky' && streamInfo.url.endsWith('.m3u8'))
        // dailymotion also responds with the wrong content-type sometimes
        || (streamInfo.service === 'dailymotion' && URL.parse(streamInfo.url)?.pathname.endsWith('.m3u8'));
}

export async function handleHlsPlaylist(streamInfo, req, res) {
    const rawPlaylist = await req.body.text();
    const rewritten = rewritePlaylist(rawPlaylist, streamInfo);
    console.log(rewritten)
    res.send(rewritten);
}

async function getSegmentSize(url, config) {
    const segmentResponse = await request(url, {
        ...config,
        throwOnError: true
    });

    if (segmentResponse.headers['content-length']) {
        segmentResponse.body.dump();
        return +segmentResponse.headers['content-length'];
    }

    // if the response does not have a content-length
    // header, we have to compute it ourselves
    let size = 0;

    for await (const data of segmentResponse.body) {
        size += data.length;
    }

    return size;
}

export async function probeInternalHLSTunnel(streamInfo) {
    const { url, headers, dispatcher, signal } = streamInfo;

    // remove all falsy headers
    Object.keys(headers).forEach(key => {
        if (!headers[key]) delete headers[key];
    });

    const config = { headers, dispatcher, signal, maxRedirections: 16 };

    const manifestResponse = await fetch(url, config);

    const manifest = HLS.parse(await manifestResponse.text());
    if (manifest.segments.length === 0)
        return -1;

    const segmentSamples = await Promise.all(
        Array(5).fill().map(async () => {
            const manifestIdx = Math.floor(Math.random() * manifest.segments.length);
            const randomSegment = manifest.segments[manifestIdx];
            if (!randomSegment.uri)
                throw "segment is missing URI";

            let segmentUrl;

            if (getURL(randomSegment.uri)) {
                segmentUrl = new URL(randomSegment.uri);
            } else {
                segmentUrl = new URL(randomSegment.uri, streamInfo.url);
            }

            const segmentSize = await getSegmentSize(segmentUrl, config) / randomSegment.duration;
            return segmentSize;
        })
    );

    const averageBitrate = segmentSamples.reduce((a, b) => a + b) / segmentSamples.length;
    const totalDuration = manifest.segments.reduce((acc, segment) => acc + segment.duration, 0);

    return averageBitrate * totalDuration;
}
