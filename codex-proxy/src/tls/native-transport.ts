/**
 * Native transport — uses a Rust addon (reqwest + rustls) for HTTP requests.
 *
 * TLS fingerprint matches the real Codex Desktop (codex-rs binary) exactly:
 * reqwest 0.12.28 + hyper-rustls 0.27.7 + rustls 0.23.36.
 *
 * This avoids the Chrome TLS / Codex Desktop UA mismatch that
 * curl-impersonate introduced.
 */

import { resolve } from "path";
import { existsSync, readFileSync } from "fs";
import { execSync } from "child_process";
import { createRequire } from "module";
import type { TlsTransport, TlsTransportResponse } from "./transport.js";
import { getProxyUrl } from "./proxy.js";
import { getConfig } from "../config.js";
import { getBinDir } from "../paths.js";

interface NativeGetResponse {
  status: number;
  body: string;
  setCookieHeaders: string[];
}

interface NativePostResponse {
  status: number;
  body: string;
}

interface NativeStreamMeta {
  status: number;
  headers: Record<string, string>;
  setCookieHeaders: string[];
}

interface NativeBindings {
  httpGet(
    url: string,
    headers: Record<string, string>,
    timeoutSec?: number | null,
    proxyUrl?: string | null,
    forceHttp11?: boolean | null,
  ): Promise<NativeGetResponse>;
  httpPost(
    url: string,
    headers: Record<string, string>,
    body: string,
    timeoutSec?: number | null,
    proxyUrl?: string | null,
    forceHttp11?: boolean | null,
  ): Promise<NativePostResponse>;
  httpPostStream(
    url: string,
    headers: Record<string, string>,
    body: string,
    onChunk: (chunk: Buffer | null | undefined) => void,
    proxyUrl?: string | null,
    forceHttp11?: boolean | null,
  ): Promise<NativeStreamMeta>;
}

export interface NativeRuntime {
  platform: NodeJS.Platform;
  arch: string;
  musl: boolean;
}

interface NativeBindingCandidate {
  localName: string;
  packageName: string;
}

/** Resolve the effective proxy URL for a request. */
function resolveProxy(proxyUrl: string | null | undefined): string | null {
  if (proxyUrl === null) return null; // explicit direct
  if (proxyUrl !== undefined) return proxyUrl; // explicit proxy
  return getProxyUrl(); // global default
}

function singleCandidate(localName: string, packageName: string): NativeBindingCandidate[] {
  return [{ localName, packageName }];
}

function isMusl(): boolean {
  if (!process.report || typeof process.report.getReport !== "function") {
    try {
      const lddPath = execSync("which ldd").toString().trim();
      return readFileSync(lddPath, "utf8").includes("musl");
    } catch {
      return true;
    }
  }

  const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
  return !report.header?.glibcVersionRuntime;
}

function getNativeRuntime(): NativeRuntime {
  return {
    platform: process.platform,
    arch: process.arch,
    musl: process.platform === "linux" ? isMusl() : false,
  };
}

export function getNativeBindingCandidates(
  runtime: NativeRuntime = getNativeRuntime(),
): NativeBindingCandidate[] {
  switch (runtime.platform) {
    case "android":
      switch (runtime.arch) {
        case "arm64":
          return singleCandidate("codex-tls.android-arm64.node", "codex-tls-android-arm64");
        case "arm":
          return singleCandidate("codex-tls.android-arm-eabi.node", "codex-tls-android-arm-eabi");
        default:
          throw new Error(`Unsupported architecture on Android: ${runtime.arch}`);
      }
    case "win32":
      switch (runtime.arch) {
        case "x64":
          return singleCandidate("codex-tls.win32-x64-msvc.node", "codex-tls-win32-x64-msvc");
        case "ia32":
          return singleCandidate("codex-tls.win32-ia32-msvc.node", "codex-tls-win32-ia32-msvc");
        case "arm64":
          return singleCandidate("codex-tls.win32-arm64-msvc.node", "codex-tls-win32-arm64-msvc");
        default:
          throw new Error(`Unsupported architecture on Windows: ${runtime.arch}`);
      }
    case "darwin":
      switch (runtime.arch) {
        case "x64":
          return [
            { localName: "codex-tls.darwin-universal.node", packageName: "codex-tls-darwin-universal" },
            { localName: "codex-tls.darwin-x64.node", packageName: "codex-tls-darwin-x64" },
          ];
        case "arm64":
          return [
            { localName: "codex-tls.darwin-universal.node", packageName: "codex-tls-darwin-universal" },
            { localName: "codex-tls.darwin-arm64.node", packageName: "codex-tls-darwin-arm64" },
          ];
        default:
          throw new Error(`Unsupported architecture on macOS: ${runtime.arch}`);
      }
    case "freebsd":
      if (runtime.arch !== "x64") {
        throw new Error(`Unsupported architecture on FreeBSD: ${runtime.arch}`);
      }
      return singleCandidate("codex-tls.freebsd-x64.node", "codex-tls-freebsd-x64");
    case "linux":
      switch (runtime.arch) {
        case "x64":
          return runtime.musl
            ? singleCandidate("codex-tls.linux-x64-musl.node", "codex-tls-linux-x64-musl")
            : singleCandidate("codex-tls.linux-x64-gnu.node", "codex-tls-linux-x64-gnu");
        case "arm64":
          return runtime.musl
            ? singleCandidate("codex-tls.linux-arm64-musl.node", "codex-tls-linux-arm64-musl")
            : singleCandidate("codex-tls.linux-arm64-gnu.node", "codex-tls-linux-arm64-gnu");
        case "arm":
          return runtime.musl
            ? singleCandidate("codex-tls.linux-arm-musleabihf.node", "codex-tls-linux-arm-musleabihf")
            : singleCandidate("codex-tls.linux-arm-gnueabihf.node", "codex-tls-linux-arm-gnueabihf");
        case "riscv64":
          return runtime.musl
            ? singleCandidate("codex-tls.linux-riscv64-musl.node", "codex-tls-linux-riscv64-musl")
            : singleCandidate("codex-tls.linux-riscv64-gnu.node", "codex-tls-linux-riscv64-gnu");
        case "s390x":
          return singleCandidate("codex-tls.linux-s390x-gnu.node", "codex-tls-linux-s390x-gnu");
        default:
          throw new Error(`Unsupported architecture on Linux: ${runtime.arch}`);
      }
    default:
      throw new Error(`Unsupported OS: ${runtime.platform}, architecture: ${runtime.arch}`);
  }
}

function formatNativeRuntime(runtime: NativeRuntime): string {
  if (runtime.platform === "linux") {
    return `${runtime.platform}-${runtime.arch}-${runtime.musl ? "musl" : "gnu"}`;
  }
  return `${runtime.platform}-${runtime.arch}`;
}

function hasResolvableNativePackage(loaderPath: string, packageName: string): boolean {
  try {
    createRequire(loaderPath).resolve(packageName);
    return true;
  } catch {
    return false;
  }
}

function findNativeBinding(
  nativeDir: string,
  runtime: NativeRuntime = getNativeRuntime(),
): NativeBindingCandidate | null {
  const loaderPath = resolve(nativeDir, "index.js");
  if (!existsSync(loaderPath)) return null;

  for (const candidate of getNativeBindingCandidates(runtime)) {
    if (existsSync(resolve(nativeDir, candidate.localName))) {
      return candidate;
    }
    if (hasResolvableNativePackage(loaderPath, candidate.packageName)) {
      return candidate;
    }
  }

  return null;
}

export function getNativeInstallHint(
  nativeDir: string = getNativeDir(),
  runtime: NativeRuntime = getNativeRuntime(),
): string {
  const candidates = getNativeBindingCandidates(runtime);
  const localTargets = candidates.map((candidate) => resolve(nativeDir, candidate.localName));
  const packageTargets = candidates.map((candidate) => candidate.packageName);
  const localText = localTargets.length === 1
    ? localTargets[0]
    : `one of ${localTargets.join(", ")}`;
  const packageText = packageTargets.length === 1
    ? packageTargets[0]
    : `one of ${packageTargets.join(", ")}`;

  return [
    `Native transport addon missing for ${formatNativeRuntime(runtime)}.`,
    `Expected ${localText} or installed package ${packageText}.`,
    "Install Rust, then run 'cd native && npm install && npm run build'.",
  ].join(" ");
}

export class NativeTransport implements TlsTransport {
  private bindings: NativeBindings;

  constructor(bindings: NativeBindings) {
    this.bindings = bindings;
  }

  isImpersonate(): boolean {
    return false; // rustls, not Chrome
  }

  async post(
    url: string,
    headers: Record<string, string>,
    body: string,
    signal?: AbortSignal,
    _timeoutSec?: number,
    proxyUrl?: string | null,
  ): Promise<TlsTransportResponse> {
    if (signal?.aborted) {
      throw new Error("Request aborted");
    }

    const proxy = resolveProxy(proxyUrl);

    // Set up a ReadableStream that receives chunks from the Rust callback
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
      cancel() {
        streamController = null;
      },
    });

    const onChunk = (chunk: Buffer | null | undefined): void => {
      if (!streamController) return;
      if (chunk == null) {
        try { streamController.close(); } catch { /* already closed */ }
        streamController = null;
      } else {
        // Buffer extends Uint8Array — enqueue directly without copying
        try { streamController.enqueue(chunk); } catch { /* closed */ }
      }
    };

    const meta = await this.bindings.httpPostStream(
      url,
      headers,
      body,
      onChunk,
      proxy,
      getConfig().tls.force_http11,
    );

    // Handle abort signal
    if (signal) {
      const onAbort = (): void => {
        if (streamController) {
          try { streamController.close(); } catch { /* already closed */ }
          streamController = null;
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }

    // Convert flat headers to Web Headers object
    const responseHeaders = new Headers();
    for (const [key, value] of Object.entries(meta.headers)) {
      // Skip set-cookie from main headers (handled separately)
      if (key.toLowerCase() === "set-cookie") continue;
      responseHeaders.append(key, value);
    }

    return {
      status: meta.status,
      headers: responseHeaders,
      body: readable,
      setCookieHeaders: meta.setCookieHeaders,
    };
  }

  async get(
    url: string,
    headers: Record<string, string>,
    timeoutSec?: number,
    proxyUrl?: string | null,
  ): Promise<{ status: number; body: string }> {
    const proxy = resolveProxy(proxyUrl);
    const h11 = getConfig().tls.force_http11;
    const result = await this.bindings.httpGet(url, headers, timeoutSec, proxy, h11);
    return { status: result.status, body: result.body };
  }

  async getWithCookies(
    url: string,
    headers: Record<string, string>,
    timeoutSec?: number,
    proxyUrl?: string | null,
  ): Promise<{ status: number; body: string; setCookieHeaders: string[] }> {
    const proxy = resolveProxy(proxyUrl);
    return this.bindings.httpGet(url, headers, timeoutSec, proxy, getConfig().tls.force_http11);
  }

  async simplePost(
    url: string,
    headers: Record<string, string>,
    body: string,
    timeoutSec?: number,
    proxyUrl?: string | null,
  ): Promise<{ status: number; body: string }> {
    const proxy = resolveProxy(proxyUrl);
    return this.bindings.httpPost(url, headers, body, timeoutSec, proxy, getConfig().tls.force_http11);
  }
}

/**
 * Resolve the native addon directory.
 * In Electron (embedded): binDir is resources/bin → sibling native/ dir.
 * In CLI (dev):           binDir is ./bin         → sibling native/ dir.
 */
function getNativeDir(): string {
  return resolve(getBinDir(), "..", "native");
}

/** Check if the native addon is available for the current platform. */
export function isNativeAvailable(): boolean {
  return findNativeBinding(getNativeDir()) !== null;
}

/** Create a NativeTransport instance. Throws if the addon is not available. */
export async function createNativeTransport(): Promise<NativeTransport> {
  const nativeDir = getNativeDir();
  const loaderPath = resolve(nativeDir, "index.js");

  if (!existsSync(loaderPath)) {
    throw new Error(`Native addon loader not found at ${loaderPath}. ${getNativeInstallHint(nativeDir)}`);
  }

  if (!findNativeBinding(nativeDir)) {
    throw new Error(getNativeInstallHint(nativeDir));
  }

  // Dynamic import of the CJS loader generated by napi-rs
  const require = createRequire(loaderPath);
  let bindings: NativeBindings;
  try {
    bindings = require(loaderPath) as NativeBindings;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load native transport addon via ${loaderPath}: ${message}`);
  }

  if (!bindings.httpGet || !bindings.httpPost || !bindings.httpPostStream) {
    throw new Error("Native addon loaded but missing expected exports (httpGet, httpPost, httpPostStream)");
  }

  return new NativeTransport(bindings);
}
