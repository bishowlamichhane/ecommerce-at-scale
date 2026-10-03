import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ipKey, isValidUserId } from "../ratelimit/identity.js";
import { normalizePath, compileLimit } from "../ratelimit/policies.js";
import { parseTrustProxy } from "../config.js";

describe("ipKey", () => {
  const cases = [
    ["203.0.113.7", "203.0.113.7"],
    ["::ffff:127.0.0.1", "127.0.0.1"], // IPv4 written as IPv6 (Node's dual-stack sockets)
    ["::FFFF:10.0.0.1", "10.0.0.1"],
    ["::1", "0:0:0:0::/64"],
    ["2001:db8::1", "2001:db8:0:0::/64"],
    ["2001:0db8:0000:0000:abcd::1", "2001:db8:0:0::/64"],
    ["2001:DB8:1:2:3:4:5:6", "2001:db8:1:2::/64"],
    ["fe80::1%eth0", "fe80:0:0:0::/64"], // zone id
    ["64:ff9b::192.0.2.1", "64:ff9b:0:0::/64"], // embedded IPv4 (NAT64)
    ["::", "0:0:0:0::/64"],
    ["not-an-ip", "unknown"],
    ["", "unknown"],
    [undefined, "unknown"],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${expected}`, () => assert.equal(ipKey(input), expected));
  }

  it("puts every address of one IPv6 /64 in the same bucket", () => {
    assert.equal(ipKey("2001:db8:aa:bb::1"), ipKey("2001:db8:aa:bb:ffff:ffff:ffff:ffff"));
    assert.notEqual(ipKey("2001:db8:aa:bb::1"), ipKey("2001:db8:aa:bc::1"));
  });
});

describe("isValidUserId", () => {
  for (const id of ["shopper-0f8fad5b-d9cb-469f-a165-70867728950e", "user-42", "bot-3", "a", "x".repeat(64), "me@example.com", "tenant:7.user_9"]) {
    it(`accepts ${JSON.stringify(id.length > 20 ? `${id.slice(0, 20)}…` : id)}`, () => assert.equal(isValidUserId(id), true));
  }
  for (const id of ["", "x".repeat(65), "has space", "a, b", "semi;colon", "quote\"", "new\nline", "ünïcode", "../../etc"]) {
    it(`refuses ${JSON.stringify(id.length > 20 ? `${id.slice(0, 20)}…` : id)}`, () => assert.equal(isValidUserId(id), false));
  }
});

describe("normalizePath", () => {
  const cases = [
    ["/orders/buy-now", "/orders/buy-now"],
    ["/ORDERS/BUY-NOW/", "/orders/buy-now"],
    ["//orders//buy-now", "/orders/buy-now"],
    ["/", "/"],
  ];
  for (const [input, expected] of cases) {
    it(`${input} → ${expected}`, () => assert.equal(normalizePath(input), expected));
  }
});

describe("compileLimit", () => {
  it("turns a rate into a whole-millisecond interval", () => {
    assert.equal(compileLimit("p", { by: "ip", burst: 100, perPeriod: 1200, period: 60 }).intervalMs, 50);
  });
  for (const bad of [{ burst: 0 }, { burst: 1.5 }, { perPeriod: -1 }, { period: "60" }, { perPeriod: 100_000, period: 1 }]) {
    it(`refuses ${JSON.stringify(bad)}`, () => {
      assert.throws(() => compileLimit("p", { by: "ip", burst: 1, perPeriod: 1, period: 1, ...bad }));
    });
  }
});

describe("parseTrustProxy", () => {
  it("trusts nobody by default", () => {
    assert.equal(parseTrustProxy(""), false);
    assert.equal(parseTrustProxy(undefined), false);
    assert.equal(parseTrustProxy("false"), false);
  });
  it("passes named proxies, CIDRs and hop counts to Express", () => {
    assert.equal(parseTrustProxy("loopback"), "loopback");
    assert.equal(parseTrustProxy("10.0.0.0/8, 172.16.0.0/12"), "10.0.0.0/8, 172.16.0.0/12");
    assert.equal(parseTrustProxy("1"), 1);
  });
  it("refuses `true`, which would believe any client's X-Forwarded-For", () => {
    assert.throws(() => parseTrustProxy("true"), /believe any client/);
  });
});
