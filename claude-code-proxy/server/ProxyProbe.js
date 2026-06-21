const http = require('http');
const https = require('https');
const { normalizeHeaders, parseQuotaHeaders } = require('./quota');

function probeProxy({ baseUrl = null, host, port, model = 'claude-sonnet-4-5' }) {
  return new Promise((resolve, reject) => {
    const targetUrl = baseUrl ? new URL('/v1/messages', baseUrl) : null;
    const transport = targetUrl?.protocol === 'https:' ? https : http;
    const body = JSON.stringify({
      model,
      max_tokens: 1,
      stream: false,
      messages: [
        {
          role: 'user',
          content: 'Reply with exactly: ok'
        }
      ]
    });

    const req = transport.request({
      host: targetUrl?.hostname || host,
      port: targetUrl?.port || port,
      path: targetUrl?.pathname || '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-dashboard-probe': '1'
      }
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => {
        raw += chunk.toString();
      });
      res.on('end', () => {
        let parsedBody = {};
        if (raw) {
          try {
            parsedBody = JSON.parse(raw);
          } catch (error) {
            reject(new Error(`Failed to parse proxy probe response: ${error.message}`));
            return;
          }
        }

        const headers = normalizeHeaders(res.headers);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const message = parsedBody?.error?.message || parsedBody?.error || `Proxy probe failed with status ${res.statusCode}`;
          reject(new Error(message));
          return;
        }

        resolve({
          statusCode: res.statusCode,
          headers,
          body: parsedBody,
          quota: parseQuotaHeaders(headers),
          org_id: headers['anthropic-organization-id'] || null,
          requestId: headers['request-id'] || null
        });
      });
    });

    req.setTimeout(15000, () => {
      req.destroy(new Error('Proxy probe timeout'));
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = {
  probeProxy
};
