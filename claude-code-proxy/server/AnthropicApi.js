const https = require("https");
const { parseQuotaHeaders, normalizeHeaders } = require("./quota");

const DEFAULT_BETA_HEADERS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "fine-grained-tool-streaming-2025-05-14"
];

function makeRequest({ method, requestPath, token, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const requestHeaders = {
      "anthropic-version": "2023-06-01",
      "Authorization": `Bearer ${token}`,
      "User-Agent": "claude-code-proxy/1.0.0",
      ...headers
    };

    if (payload) {
      requestHeaders["Content-Type"] = "application/json";
      requestHeaders["Content-Length"] = Buffer.byteLength(payload);
    }

    const req = https.request({
      hostname: "api.anthropic.com",
      port: 443,
      path: requestPath,
      method,
      headers: requestHeaders
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        const normalizedHeaders = normalizeHeaders(res.headers);
        const parsedBody = data ? JSON.parse(data) : {};
        resolve({
          statusCode: res.statusCode,
          headers: normalizedHeaders,
          body: parsedBody
        });
      });
    });

    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error("Anthropic request timeout"));
    });

    if (payload) {
      req.write(payload);
    }

    req.end();
  });
}

async function listModels(token) {
  return makeRequest({
    method: "GET",
    requestPath: "/v1/models",
    token
  });
}

function pickProbeModel(models = []) {
  const preferred = models.find((model) => model.id && model.id.includes("haiku"));
  if (preferred) {
    return preferred.id;
  }

  const secondary = models.find((model) => model.id && model.id.includes("sonnet"));
  if (secondary) {
    return secondary.id;
  }

  return models[0]?.id || "claude-haiku-4-5-20251001";
}

async function probeQuota(token) {
  let modelId = "claude-haiku-4-5-20251001";

  try {
    const modelsResponse = await listModels(token);
    if (modelsResponse.statusCode >= 200 && modelsResponse.statusCode < 300) {
      modelId = pickProbeModel(modelsResponse.body?.data || []);
    }
  } catch (error) {
    // Fall back to the default probe model if model enumeration fails.
  }

  const response = await makeRequest({
    method: "POST",
    requestPath: "/v1/messages",
    token,
    headers: {
      "anthropic-beta": DEFAULT_BETA_HEADERS.join(",")
    },
    body: {
      model: modelId,
      max_tokens: 1,
      stream: false,
      system: [{
        type: "text",
        text: "You are Claude Code, Anthropic's official CLI for Claude."
      }],
      messages: [{
        role: "user",
        content: [{
          type: "text",
          text: "ping"
        }]
      }]
    }
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const message = response.body?.error?.message || `Probe failed with status ${response.statusCode}`;
    throw new Error(message);
  }

  return {
    model: modelId,
    statusCode: response.statusCode,
    requestId: response.headers["request-id"] || null,
    org_id: response.headers["anthropic-organization-id"] || null,
    headers: response.headers,
    quota: parseQuotaHeaders(response.headers),
    usage: response.body?.usage || null
  };
}

module.exports = {
  listModels,
  probeQuota
};
