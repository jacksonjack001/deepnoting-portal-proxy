import { describe, expect, it } from "vitest";

import {
  getNativeBindingCandidates,
  getNativeInstallHint,
  type NativeRuntime,
} from "@src/tls/native-transport.js";

describe("native transport binding selection", () => {
  it("selects the glibc Linux x64 binding", () => {
    const runtime: NativeRuntime = {
      platform: "linux",
      arch: "x64",
      musl: false,
    };

    expect(getNativeBindingCandidates(runtime)).toEqual([
      {
        localName: "codex-tls.linux-x64-gnu.node",
        packageName: "codex-tls-linux-x64-gnu",
      },
    ]);
  });

  it("selects the musl Linux x64 binding", () => {
    const runtime: NativeRuntime = {
      platform: "linux",
      arch: "x64",
      musl: true,
    };

    expect(getNativeBindingCandidates(runtime)).toEqual([
      {
        localName: "codex-tls.linux-x64-musl.node",
        packageName: "codex-tls-linux-x64-musl",
      },
    ]);
  });

  it("prefers universal macOS bindings before arch-specific fallback", () => {
    const runtime: NativeRuntime = {
      platform: "darwin",
      arch: "arm64",
      musl: false,
    };

    expect(getNativeBindingCandidates(runtime)).toEqual([
      {
        localName: "codex-tls.darwin-universal.node",
        packageName: "codex-tls-darwin-universal",
      },
      {
        localName: "codex-tls.darwin-arm64.node",
        packageName: "codex-tls-darwin-arm64",
      },
    ]);
  });

  it("explains how to build a missing binding", () => {
    const runtime: NativeRuntime = {
      platform: "linux",
      arch: "x64",
      musl: false,
    };

    const hint = getNativeInstallHint("/tmp/native", runtime);

    expect(hint).toContain("linux-x64-gnu");
    expect(hint).toContain("/tmp/native/codex-tls.linux-x64-gnu.node");
    expect(hint).toContain("codex-tls-linux-x64-gnu");
    expect(hint).toContain("cd native && npm install && npm run build");
  });
});
