export class Stats {
    constructor(url, options) {
        this._options = options;
        this._responseBodyCounter = 0;
        this.url = url;
        this.firstRequestId = undefined;
        this.firstRequestMs = undefined;
        this.domContentEventFiredMs = undefined;
        this.loadEventFiredMs = undefined;
        this.entries = new Map();
        this.user = undefined; // filled from outside
    }
}

export class StatsBuilder {

  static processEvent(stats, {method, params}) {
     const methodName = `_${method.replace('.', '_')}`;
     const handler = StatsBuilder[methodName];
     if (handler) {
         handler(stats, params);
     }
 }

 static _Page_domContentEventFired(stats, params) {
     const {timestamp} = params;
     stats.domContentEventFiredMs = timestamp * 1000;
 }

 static _Page_loadEventFired(stats, params) {
     const {timestamp} = params;
     stats.loadEventFiredMs = timestamp * 1000;
 }

 static _Network_requestWillBeSent(stats, params) {
     const {requestId, initiator, timestamp, redirectResponse} = params;
     // skip data URI
     if (params.request.url.match('^data:')) {
         return;
     }
     // the first is the first request
     if (!stats.firstRequestId && initiator.type === 'other') {
         stats.firstRequestMs = timestamp * 1000;
         stats.firstRequestId = requestId;
     }
     // redirect responses are delivered along the next request
     if (redirectResponse) {
         const redirectEntry = stats.entries[requestId];
         // craft a synthetic response params
         redirectEntry.responseParams = {
             response: redirectResponse
         };
         // set the redirect response finished when the redirect
         // request *will be sent* (this may be an approximation)
         redirectEntry.responseFinishedS = timestamp;
         redirectEntry.encodedResponseLength = redirectResponse.encodedDataLength;
         // since Chrome uses the same request id for all the
         // redirect requests, it is necessary to disambiguate
         const newId = requestId + '_redirect_' + timestamp;
         // rename the previous metadata entry
         stats.entries[newId] = redirectEntry;
         delete stats.entries[requestId];
     }
     // initialize this entry
     stats.entries[requestId] = {
         requestParams: params,
         responseParams: undefined,
         responseLength: 0, // built incrementally
         encodedResponseLength: undefined,
         responseFinishedS: undefined,
         responseBody: undefined,
         responseBodyIsBase64: undefined,
         newPriority: undefined
     };
 }

 static _Network_dataReceived(stats, params) {
     const {requestId, dataLength} = params;
     const entry = stats.entries[requestId];
     if (!entry) {
         return;
     }
     entry.responseLength += dataLength;
 }

 static _Network_responseReceived(stats, params) {
     const entry = stats.entries[params.requestId];
     if (!entry) {
         return;
     }
     entry.responseParams = params;
 }

 static _Network_resourceChangedPriority(stats, params) {
     const {requestId, newPriority} = params;
     const entry = stats.entries[requestId];
     if (!entry) {
         return;
     }
     entry.newPriority = newPriority;
 }

 static _Network_loadingFinished(stats, params) {
     const {requestId, timestamp, encodedDataLength} = params;
     const entry = stats.entries[requestId];
     if (!entry) {
         return;
     }
     entry.encodedResponseLength = encodedDataLength;
     entry.responseFinishedS = timestamp;
     // check termination condition
     stats._responseBodyCounter++;
 }

 static _Network_loadingFailed(stats, params) {
     const {requestId, errorText, canceled, timestamp} = params;
     const entry = stats.entries[requestId];
     if (!entry) {
         return;
     }
     entry.responseFailedS = timestamp;
 }

 static _Network_getResponseBody(stats, params) {
     const {requestId, body, base64Encoded} = params;
     const entry = stats.entries[requestId];
     if (!entry) {
         return;
     }
     entry.responseBody = body;
     entry.responseBodyIsBase64 = base64Encoded;
     // check termination condition
     stats._responseBodyCounter--;
 }

 static _Network_webSocketWillSendHandshakeRequest(stats, params) {
     // initialize this entry (copied from requestWillbesent)
     stats.entries[params.requestId] = {
         isWebSocket: true,
         frames: [],
         requestParams: params,
         responseParams: undefined,
         responseLength: 0, // built incrementally
         encodedResponseLength: undefined,
         responseFinishedS: undefined,
         responseBody: undefined,
         responseBodyIsBase64: undefined,
         newPriority: undefined
     };
 }

 static _Network_webSocketHandshakeResponseReceived(stats, params) {
     // reuse the general handler
     stats._Network_responseReceived(stats, params);
 }

 static _Network_webSocketClosed(stats, params) {
     const {requestId, timestamp} = params;
     const entry = stats.entries[requestId];
     if (!entry) {
         return;
     }
     // XXX keep track of the whole WebSocket session duration, failure to
     // receive this message though must not discard the entry since the page
     // loading event may happen well before the actual WebSocket termination
     entry.responseFinishedS = timestamp;
 }

 static _Network_webSocketFrameSent(stats, params) {
     const {requestId, timestamp, response} = params;
     const entry = stats.entries[requestId];
     if (!entry) {
         return;
     }
     entry.frames.push({
         type: 'send',
         time: timestamp,
         opcode: response.opcode,
         data: response.payloadData
     });
 }

 static _Network_webSocketFrameReceived(stats, params) {
     const {requestId, timestamp, response} = params;
     const entry = stats.entries[requestId];
     if (!entry) {
         return;
     }
     entry.frames.push({
         type: 'receive',
         time: timestamp,
         opcode: response.opcode,
         data: response.payloadData
     });
 }
}
