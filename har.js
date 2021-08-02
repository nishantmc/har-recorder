export class HARBuilder {
  constructor() {}

 create(pages) {
    // HAR template
    const har = {
        log: {
            version: '1.2',
            creator: {
                name: 'HAR Recorder',
                version: 1,
                comment: 'Records network request and generates HAR file.'
            },
            pages: [],
            entries: []
        }
    };
    // fill the HAR template each page info
    for (const [pageIndex, stats] of pages.entries()) {
        const pageId = `page_${pageIndex + 1}_${String(Math.random()).slice(2)}`;
        const log = this.parsePage(String(pageId), stats);
        har.log.pages.push(log.page);
        har.log.entries.push(...log.entries);
    }
    return har;
}

 parsePage(pageId, stats) {
    // page load started at
    //const firstRequest = stats.entries.get(stats.firstRequestId).requestParams;
    //const wallTimeMs = firstRequest.wallTime * 1000;
    //const startedDateTime = new Date(wallTimeMs).toISOString();
    const startedDateTime = 0;
    // page timings
    //const onContentLoad = stats.domContentEventFiredMs - stats.firstRequestMs;
    //const onLoad = stats.loadEventFiredMs - stats.firstRequestMs;

    const onContentLoad = 0;
    const onLoad = 0;
    // process this page load entries
    const entries = [...Object.values(stats.entries)]
        .map((entry) => this.parseEntry(pageId, entry))
        .filter((entry) => entry);
    // outcome
    return {
        page: {
            id: pageId,
            title: stats.url,
            startedDateTime,
            pageTimings: {
                onContentLoad,
                onLoad
            },
            _user: stats.user
        },
        entries
    };
}

 parseEntry(pageref, entry) {
    // skip requests without response (requestParams is always present; except
    // for WebSockets see Stats._Network_webSocketClosed)
    if (!entry.responseParams ||
        !entry.isWebSocket && !entry.responseFinishedS && !entry.responseFailedS) {
        return null;
    }
    // skip entries without timing information (doc says optional)
    if (!entry.isWebSocket && !entry.responseParams.response.timing) {
        return null;
    }
    // extract common fields
    const {request} = entry.requestParams;
    const {response} = entry.responseParams;
    // fix WebSocket values since the protocol provides incomplete information
    if (entry.isWebSocket) {
        const requestStatus = entry.responseParams.response.requestHeadersText.split(' ');
        request.method = requestStatus[0];
        request.url = requestStatus[1];
        response.protocol = entry.responseParams.response.headersText.split(' ')[0];
    }
    // entry started
    const wallTimeMs = entry.requestParams.wallTime * 1000;
    const startedDateTime = new Date(wallTimeMs).toISOString();
    // HTTP version or protocol name (e.g., quic)
    const httpVersion = response.protocol || 'unknown';
    // request/response status
    const {method, url} = request;
    const {status, statusText} = response;
    // parse and measure headers
    const headers = this.parseHeaders(httpVersion, request, response);
    // check for redirections
    const redirectURL = this.getHeaderValue(response.headers, 'location', '');
    // parse query string
    const queryString = this.parseQueryString(request.url);
    // parse post data
    const postData = this.parsePostData(request, headers);
    // compute entry timings
    const {time, timings} = this.computeTimings(entry);
    // fetch connection information (strip IPv6 [...])
    let serverIPAddress = response.remoteIPAddress;
    if (serverIPAddress) {
        serverIPAddress = serverIPAddress.replace(/^\[(.*)\]$/, '$1');
    }
    const connection = String(response.connectionId);
    // fetch entry initiator
    const _initiator = entry.requestParams.initiator;
    // fetch resource priority
    const {changedPriority} = entry;
    const newPriority = changedPriority && changedPriority.newPriority;
    const _priority = newPriority || request.initialPriority;
    let _resourceType = entry.requestParams.type ? entry.requestParams.type.toLowerCase() : undefined;
    // parse and measure payloads
    const payload = this.computePayload(entry, headers);
    const {mimeType} = response;
    const encoding = entry.responseBodyIsBase64 ? 'base64' : undefined;
    // add WebSocket frames
    let _webSocketMessages;
    if (entry.isWebSocket) {
        _webSocketMessages = entry.frames;
        _resourceType = 'websocket';
    }
    // fill entry
    return {
        pageref,
        startedDateTime,
        time,
        request: {
            method,
            url,
            httpVersion,
            cookies: [], // TODO
            headers: headers.request.pairs,
            queryString,
            headersSize: headers.request.size,
            bodySize: payload.request.bodySize,
            postData
        },
        response: {
            status,
            statusText,
            httpVersion,
            cookies: [], // TODO
            headers: headers.response.pairs,
            redirectURL,
            headersSize: headers.response.size,
            bodySize: payload.response.bodySize,
            _transferSize: payload.response.transferSize,
            content: {
                size: entry.responseLength,
                mimeType: entry.isWebSocket ? 'x-unknown' : mimeType,
                compression: payload.response.compression,
                text: entry.responseBody,
                encoding
            }
        },
        cache: {},
        _fromDiskCache: response.fromDiskCache,
        timings,
        serverIPAddress,
        connection,
        _initiator,
        _priority,
        _webSocketMessages,
        _resourceType
    };
}

 parseHeaders(httpVersion, request, response) {
    // convert headers from map to pairs
    const requestHeaders = response.requestHeaders || request.headers;
    const responseHeaders = response.headers;
    const headers = {
        request: {
            map: requestHeaders,
            pairs: this.zipNameValue(requestHeaders),
            size: -1
        },
        response: {
            map: responseHeaders,
            pairs: this.zipNameValue(responseHeaders),
            size: -1
        }
    };
    // estimate the header size (including HTTP status line) according to the
    // protocol (this information not available due to possible compression in
    // newer versions of HTTP)
    if (httpVersion.match(/^http\/[01].[01]$/)) {
        const requestText = this.getRawRequest(request, headers.request.pairs);
        const responseText = this.getRawResponse(response, headers.response.pairs);
        headers.request.size = requestText.length;
        headers.response.size = responseText.length;
    }
    return headers;
}

 computeTimings(entry) {
    // handle the websocket case specially
    if (entry.isWebSocket) {
        // from initial request to the last frame, this is obviously an
        // approximation, but HAR does not directly support WebSockets
        const sessionTime = (
            entry.frames.length === 0 ? -1 :
                this.toMilliseconds(entry.frames[entry.frames.length - 1].time - entry.requestParams.timestamp)
        );
        return {
            time: sessionTime,
            timings: {
                blocked: -1,
                dns: -1,
                connect: -1,
                send: 0,
                wait: sessionTime,
                receive: -1, // XXX does not really make sense for WebSockets...
                ssl: -1
            }
        };
    }
    // see https://github.com/ChromeDevTools/devtools-frontend/blob/29fab47578afb1ead4eb63414ec30cada4814b62/front_end/sdk/HARLog.js#L255-L329
    const timing = entry.responseParams.response.timing;
    // compute the total duration (including blocking time)
    const finishedTimestamp = entry.responseFinishedS || entry.responseFailedS;
    const time = this.toMilliseconds(finishedTimestamp - entry.requestParams.timestamp);
    // compute individual components
    const blockedBase = this.toMilliseconds(timing.requestTime - entry.requestParams.timestamp);
    const blockedStart = this.firstNonNegative([
        timing.dnsStart, timing.connectStart, timing.sendStart
    ]);
    const blocked = blockedBase + (blockedStart === -1 ? 0 : blockedStart);
    let dns = -1;
    if (timing.dnsStart >= 0) {
        const start = this.firstNonNegative([timing.connectStart, timing.sendStart]);
        dns = start - timing.dnsStart;
    }
    let connect = -1;
    if (timing.connectStart >= 0) {
        connect = timing.sendStart - timing.connectStart;
    }
    const send = timing.sendEnd - timing.sendStart;
    const wait = timing.receiveHeadersEnd - timing.sendEnd;
    const receive = this.toMilliseconds(finishedTimestamp - (timing.requestTime + timing.receiveHeadersEnd / 1000));
    let ssl = -1;
    if (timing.sslStart >= 0 && timing.sslEnd >= 0) {
        ssl = timing.sslEnd - timing.sslStart;
    }
    return {
        time,
        timings: {blocked, dns, connect, send, wait, receive, ssl}
    };
}

 computePayload(entry, headers) {
    // From Chrome:
    //  - responseHeaders.size: size of the headers if available (otherwise
    //    -1, e.g., HTTP/2)
    //  - entry.responseLength: actual *decoded* body size
    //  - entry.encodedResponseLength: total on-the-wire data
    //
    // To HAR:
    //  - headersSize: size of the headers if available (otherwise -1, e.g.,
    //    HTTP/2)
    //  - bodySize: *encoded* body size
    //  - _transferSize: total on-the-wire data
    //  - content.size: *decoded* body size
    //  - content.compression: *decoded* body size - *encoded* body size
    let bodySize;
    let compression;
    let transferSize = entry.encodedResponseLength;
    if (headers.response.size === -1) {
        // if the headers size is not available (e.g., newer versions of
        // HTTP) then there is no way (?) to figure out the encoded body
        // size (see #27)
        bodySize = -1;
        compression = undefined;
    } else if (entry.responseFailedS) {
        // for failed requests (`Network.loadingFailed`) the transferSize is
        // just the header size, since that evend does not hold the
        // `encodedDataLength` field, this is performed manually (however this
        // cannot be done for HTTP/2 which is handled by the above if)
        bodySize = 0;
        compression = 0;
        transferSize = headers.response.size;
    } else {
        // otherwise the encoded body size can be obtained as follows
        bodySize = entry.encodedResponseLength - headers.response.size;
        compression = entry.responseLength - bodySize;
    }
    return {
        request: {
            // trivial case for request
            bodySize: parseInt(this.getHeaderValue(headers.request.map, 'content-length', -1), 10)
        },
        response: {
            bodySize,
            transferSize,
            compression
        }
    };
}

 zipNameValue(map) {
    const pairs = [];
    for (const [name, value] of Object.entries(map)) {
        // insert multiple pairs if the key is repeated
        const values = Array.isArray(value) ? value : [value];
        for (const value of values) {
            pairs.push({name, value});
        }
    }
    return pairs;
}

 parseQuery(query) {

   let mapQueryString = query.split("&")?.map(function(nameValue) {
        let nameValuePair = nameValue.split("=").map(decodeURIComponent);
        return {[nameValuePair[0]]: nameValuePair[1]};
    });
   return mapQueryString;
}

 getRawRequest(request, headerPairs) {
    const {method, url, protocol} = request;
    const lines = [`${method} ${url} ${protocol}`];
    for (const {name, value} of headerPairs) {
        lines.push(`${name}: ${value}`);
    }
    lines.push('', '');
    return lines.join('\r\n');
}

 getRawResponse(response, headerPairs) {
    const {status, statusText, protocol} = response;
    const lines = [`${protocol} ${status} ${statusText}`];
    for (const {name, value} of headerPairs) {
        lines.push(`${name}: ${value}`);
    }
    lines.push('', '');
    return lines.join('\r\n');
}

 getHeaderValue(headers, name, fallback) {
    const pattern = new RegExp(`^${name}$`, 'i');
    const key = Object.keys(headers).find((name) => {
        return name.match(pattern);
    });
    return key === undefined ? fallback : headers[key];
}

 parseQueryString(requestUrl) {
  const url = new URL(requestUrl);
  const pairs = [];
  for(const pair of url.searchParams.entries()) {
     pairs.push({[pair[0]]: pair[1]});
  }
  return pairs;
}

 parsePostData(request, headers) {
    const {postData} = request;
    if (!postData) {
        return undefined;
    }
    const mimeType = this.getHeaderValue(headers.request.map, 'content-type');
    const params = (
        mimeType === 'application/x-www-form-urlencoded' ?
            this.zipNameValue(this.parseQuery(postData)) : []
    );
    return {
        mimeType,
        params,
        text: postData
    };
}

 firstNonNegative(values) {
    const value = values.find((value) => value >= 0);
    return value === undefined ? -1 : value;
}

 toMilliseconds(time) {
    return time < 0 ? -1 : time * 1000;
 }
}
